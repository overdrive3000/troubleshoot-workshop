import * as cdk from '@aws-cdk/core';
import * as apigateway from '@aws-cdk/aws-apigateway';
import * as eks from '@aws-cdk/aws-eks';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as sns from '@aws-cdk/aws-sns';
import * as iam from '@aws-cdk/aws-iam';
import * as cr from '@aws-cdk/custom-resources';
import * as logs from '@aws-cdk/aws-logs';
import * as lambda from '@aws-cdk/aws-lambda';
import * as path from 'path';
import { PolicyStatement } from '@aws-cdk/aws-iam';

export interface ClusterStackProps extends cdk.StackProps {
  vpcId: string
  cloud9EnvironmentId: string
  codeBuildRoleArn: string
}
export class ClusterStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);

    // Tag the stack and its resources.
    this.tags.setTag('StackName', 'ClusterStack');

    // The VPC ID is supplied by the caller from the VPC_ID environment variable.
    const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
      vpcId: props.vpcId
    });

    // Create an EC2 instance role for the Cloud9 environment. This instance
    // role is powerful, allowing the participant to have unfettered access to
    // the provisioned account. This might be too broad. It's possible to
    // tighten this down, but there may be unintended consequences.
    const instanceRole = new iam.Role(this, 'WorkspaceInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
      ],
      description: 'Workspace EC2 instance role'
    });

    // During internal testing we found that Isengard account baselining
    // was attaching IAM roles to instances in the background. This prevents
    // the stack from being cleanly destroyed, so we will record the instance
    // role name and use it later to delete any attached policies before
    // cleanup.
    new cdk.CfnOutput(this, 'WorkspaceInstanceRoleName', {
      value: instanceRole.roleName
    });

    const instanceProfile = new iam.CfnInstanceProfile(this, 'WorkspaceInstanceProfile', {
      roles: [instanceRole.roleName]
    });

    // Obtain Cloud9 workspace instance ID and security group.
    const workspaceInstance = new cr.AwsCustomResource(this, 'WorkspaceInstance', {
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      onUpdate: {
        service: 'EC2',
        action: 'describeInstances',
        physicalResourceId: cr.PhysicalResourceId.of(props.cloud9EnvironmentId),
        parameters: {
          Filters: [
            {
              Name: 'tag:aws:cloud9:environment',
              Values: [props.cloud9EnvironmentId]
            }
          ]
        },
        outputPaths: [
          'Reservations.0.Instances.0.InstanceId',
          'Reservations.0.Instances.0.NetworkInterfaces.0.Groups.0.GroupId'
        ]
      }
    });
    const instanceId = workspaceInstance.getResponseField('Reservations.0.Instances.0.InstanceId');

    const workspaceSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this, 'WorkspaceSecurityGroup',
      workspaceInstance.getResponseField('Reservations.0.Instances.0.NetworkInterfaces.0.Groups.0.GroupId'));


    // This function provides a Custom Resource that detaches any existing IAM
    // instance profile that might be attached to the Cloud9 Environment, and
    // replaces it with the profile+role we created ourselves.
    const updateInstanceProfileFunction = new lambda.Function(this, 'UpdateInstanceProfileFunction', {
      code: lambda.Code.fromAsset(path.join(__dirname, 'update-instance-profile')),
      handler: 'index.onEventHandler',
      runtime: lambda.Runtime.NODEJS_14_X
    });
    updateInstanceProfileFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeIamInstanceProfileAssociations',
        'ec2:ReplaceIamInstanceProfileAssociation',
        'ec2:AssociateIamInstanceProfile',
        'iam:PassRole'
      ],
      resources: ['*']
    }));

    const updateInstanceProfile = new cr.Provider(this, 'UpdateInstanceProfileProvider', {
      onEventHandler: updateInstanceProfileFunction,
    });

    new cdk.CustomResource(this, 'UpdateInstanceProfile', {
      serviceToken: updateInstanceProfile.serviceToken,
      properties: {
        InstanceId: instanceId,
        InstanceProfileArn: instanceProfile.attrArn
      }
    });


    // Create our EKS cluster.
    const cluster = new eks.Cluster(this, 'Cluster', {
      vpc,
      version: eks.KubernetesVersion.V1_21,
      clusterName: 'troubleshoot-workshop',
      defaultCapacity: 0,
      mastersRole: instanceRole,
    });
    cluster.connections.allowFrom(workspaceSecurityGroup, ec2.Port.tcp(443));
    cluster.connections.allowFrom(workspaceSecurityGroup, ec2.Port.tcp(80));

    // Create Managed Nodegroup.
    const ng1 = new eks.Nodegroup(this,'ng-1', {
      cluster,
      desiredSize: 1,
      maxSize: 100,
      minSize: 1,
      capacityType: eks.CapacityType.SPOT,
      instanceTypes: [
        ec2.InstanceType.of(ec2.InstanceClass.M4, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.M5A, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.M5AD, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.M5D, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.LARGE),
      ],
      labels: {
        'nodegroup-role': 'web-workload',
      },
      subnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_NAT })
    });
    ng1.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'))
    
    // During internal testing we found that Isengard account baselining
    // was attaching IAM roles to instances in the background. This prevents
    // the stack from being cleanly destroyed, so we will record the instance
    // role name and use it later to delete any attached policies before
    // cleanup.
    new cdk.CfnOutput(this, 'NG1NodegroupRoleName', {
      value: ng1.role.roleName
    });

    // Create Tools Managed Nodegroup.
    const ng_tools = new eks.Nodegroup(this,'ng-tools', {
      cluster,
      desiredSize: 2,
      maxSize: 2,
      minSize: 2,
      instanceTypes: [
        ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.M4, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.M5A, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.M5AD, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.M5D, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
        ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.LARGE),
      ],
      labels: {
        'nodegroup-role': 'tools',
      },
      taints: [{
        effect: eks.TaintEffect.NO_SCHEDULE,
        key: 'component',
        value: 'chaos'
      }],
      subnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_NAT })
    });
    ng_tools.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'))

    // During internal testing we found that Isengard account baselining
    // was attaching IAM roles to instances in the background. This prevents
    // the stack from being cleanly destroyed, so we will record the instance
    // role name and use it later to delete any attached policies before
    // cleanup.
    new cdk.CfnOutput(this, 'ToolsNodegroupRoleName', {
      value: ng_tools.role.roleName
    });
   


    // Add our instance role as a cluster admin
    cluster.awsAuth.addMastersRole(instanceRole);


    // Since Cloud9 has the SSM agent on it, we'll take advantage of its
    // presence to prepare the instance. This includes installing kubectl,
    // setting up the kubeconfig file, and installing the SSH private key
    // into the default user's home directory. We can add more steps later
    // if we like.

    // First, allow SSM to write Run Command logs to CloudWatch Logs. This
    // will allow us to diagnose problems later.
    const runCommandRole = new iam.Role(this, 'RunCommandRole', {
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
    });
    const runCommandLogGroup = new logs.LogGroup(this, 'RunCommandLogs');
    runCommandLogGroup.grantWrite(runCommandRole);

    // Now, invoke RunCommand.
    new cr.AwsCustomResource(this, 'InstancePrep', {
      installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [runCommandRole.roleArn]
        }),
        new iam.PolicyStatement({
          actions: [
            'ssm:SendCommand'
          ],
          resources: ['*']
        })
      ]),
      onUpdate: {
        service: 'SSM',
        action: 'sendCommand',
        physicalResourceId: cr.PhysicalResourceId.of(props.cloud9EnvironmentId),
        parameters: {
          DocumentName: 'AWS-RunShellScript',
          DocumentVersion: '$LATEST',
          InstanceIds: [instanceId],
          TimeoutSeconds: 30,
          ServiceRoleArn: runCommandRole.roleArn,
          CloudWatchOutputConfig: {
            CloudWatchLogGroupName: runCommandLogGroup.logGroupName,
            CloudWatchOutputEnabled: true
          },
          Parameters: {
            commands: [
              // Resize the instance base EBS volume to 50GiB
              'export INSTANCEID=$(curl http://169.254.169.254/latest/meta-data/instance-id)',
              "export REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone | sed 's/\\(.*\\)[a-z]/\\1/')",
              `export VOLUMEID=$(aws ec2 describe-instances --instance-id $INSTANCEID --query \"Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId\" --output text --region ${this.region})`,
              `aws ec2 modify-volume --volume-id $VOLUMEID --size 50 --region ${this.region}`,
              `while [ "$(aws ec2 describe-volumes-modifications --region ${this.region} --volume-id $VOLUMEID --filters Name=modification-state,Values="optimizing","completed" --query "length(VolumesModifications)" --output text)" != "1" ]; do sleep 1; done`,
              "sudo growpart /dev/nvme0n1 1",
              "sudo resize2fs /dev/nvme0n1p1",
              // Install jq
              'sudo yum install -y jq',
              // Install kubectl
              'curl -sSL -o /tmp/kubectl https://amazon-eks.s3.us-west-2.amazonaws.com/1.21.2/2021-07-05/bin/linux/amd64/kubectl',
              'chmod +x /tmp/kubectl',
              'mv /tmp/kubectl /usr/local/bin/kubectl',
              // Update kube config to EKS cluster
              `su -l -c 'aws eks update-kubeconfig --name ${cluster.clusterName} --alias infra --region ${this.region} --role-arn ${instanceRole.roleArn}' ec2-user`,
              // Install Helm
              'curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash',
              // Install eksctl
              'curl --silent --location "https://github.com/weaveworks/eksctl/releases/latest/download/eksctl_$(uname -s)_amd64.tar.gz" | tar xz -C /tmp',
              'sudo mv /tmp/eksctl /usr/local/bin',
	            // Install jq
              'sudo yum -y install jq gettext bash-completion moreutils',
              // Install SSM Session Manager plugin
              'curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm" -o "/tmp/session-manager-plugin.rpm"',
              'sudo yum install -y /tmp/session-manager-plugin.rpm'
            ]
          },
        },
        outputPaths: ['CommandId']
      }
    });

    // Install K8S resources (helm charts etc.)
    const infrastructure_ns = cluster.addManifest('InfrastructureNamespace', {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "infrastructure"
      }
    });

    cluster.addManifest('LitmusNamespace', {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "litmus"
      }
    });
    cluster.addManifest('MonitoringNamespace', {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "monitoring"
      }
    });
    cluster.addManifest('SockShopNamespace', {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "sock-shop"
      }
    });

    // Create PriorityClass for demonstration
    cluster.addManifest('LowPriorityClass', {
      apiVersion: "scheduling.k8s.io/v1",
      kind: "PriorityClass",
      description: "Low PriorityClass",
      metadata: {
        name: "bad"
      },
      preemptionPolicy: "PreemptLowerPriority",
      value: -1
    });

    // Create a service accounts

    // CAS Policy
    const casPolicy = new iam.PolicyStatement({
      actions: [
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:DescribeTags",
        "autoscaling:SetDesiredCapacity",
        "autoscaling:TerminateInstanceInAutoScalingGroup",
        "ec2:DescribeLaunchTemplateVersions",
        "ec2:DescribeInstanceTypes"
      ],
      resources: ["*"],
      effect: iam.Effect.ALLOW
    });
    // Service account for Cluster Autoscaler
    const casServiceAccount = cluster.addServiceAccount('CASServiceAccount', {
      namespace: 'infrastructure',
      name: 'cluster-autoscaler'
    });
    casServiceAccount.addToPrincipalPolicy(casPolicy);
    casServiceAccount.node.addDependency(infrastructure_ns);
    casServiceAccount.node._actualNode.addDependency(infrastructure_ns);

    // EBS CNI Policy -- THIS POLICY IS TOO OPEN, IT SHOULD BE USED ONLY FOR TESTING
    const ebsPolicy = new iam.PolicyStatement({
      actions: [
        "ec2:CreateSnapshot",
        "ec2:AttachVolume",
        "ec2:DetachVolume",
        "ec2:ModifyVolume",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeInstances",
        "ec2:DescribeSnapshots",
        "ec2:DescribeTags",
        "ec2:DescribeVolumes",
        "ec2:DescribeVolumesModifications",
        "ec2:CreateTags",
        "ec2:DeleteTags",
        "ec2:CreateVolume",
        "ec2:DeleteVolume",
        "ec2:DeleteSnapshot"
      ],
      resources: ["*"],
      effect: iam.Effect.ALLOW
    });
    // Service account for EBS CSI Driver
    const ebsServiceAccount = cluster.addServiceAccount('EBSServiceAccount', {
      namespace: 'infrastructure',
      name: 'ebs-csi-driver'
    });
    ebsServiceAccount.addToPrincipalPolicy(ebsPolicy);
    ebsServiceAccount.node.addDependency(infrastructure_ns);
    ebsServiceAccount.node._actualNode.addDependency(infrastructure_ns);

    // AWS Load Balancer Controller Policy -- THIS POLICY IS TOO OPEN, IT SHOULD BE USED ONLY FOR TESTING
    const albPolicy = new iam.PolicyStatement({
      actions: [
        "ec2:CreateTags",
        "ec2:DeleteTags",
        "elasticloadbalancing:CreateLoadBalancer",
        "elasticloadbalancing:CreateTargetGroup",
        "elasticloadbalancing:AddTags",
        "elasticloadbalancing:RemoveTags",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:DeleteSecurityGroup",
        "elasticloadbalancing:ModifyLoadBalancerAttributes",
        "elasticloadbalancing:SetIpAddressType",
        "elasticloadbalancing:SetSecurityGroups",
        "elasticloadbalancing:SetSubnets",
        "elasticloadbalancing:DeleteLoadBalancer",
        "elasticloadbalancing:ModifyTargetGroup",
        "elasticloadbalancing:ModifyTargetGroupAttributes",
        "elasticloadbalancing:DeleteTargetGroup",
        "elasticloadbalancing:RegisterTargets",
        "elasticloadbalancing:DeregisterTargets",
        "iam:CreateServiceLinkedRole",
        "ec2:DescribeAccountAttributes",
        "ec2:DescribeAddresses",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeInternetGateways",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeInstances",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeTags",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeLoadBalancerAttributes",
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeListenerCertificates",
        "elasticloadbalancing:DescribeSSLPolicies",
        "elasticloadbalancing:DescribeRules",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeTargetGroupAttributes",
        "elasticloadbalancing:DescribeTargetHealth",
        "elasticloadbalancing:DescribeTags",
        "cognito-idp:DescribeUserPoolClient",
        "acm:ListCertificates",
        "acm:DescribeCertificate",
        "iam:ListServerCertificates",
        "iam:GetServerCertificate",
        "waf-regional:GetWebACL",
        "waf-regional:GetWebACLForResource",
        "waf-regional:AssociateWebACL",
        "waf-regional:DisassociateWebACL",
        "wafv2:GetWebACL",
        "wafv2:GetWebACLForResource",
        "wafv2:AssociateWebACL",
        "wafv2:DisassociateWebACL",
        "shield:GetSubscriptionState",
        "shield:DescribeProtection",
        "shield:CreateProtection",
        "shield:DeleteProtection",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:CreateSecurityGroup",
        "elasticloadbalancing:CreateListener",
        "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:CreateRule",
        "elasticloadbalancing:DeleteRule",
        "elasticloadbalancing:SetWebAcl",
        "elasticloadbalancing:ModifyListener",
        "elasticloadbalancing:AddListenerCertificates",
        "elasticloadbalancing:RemoveListenerCertificates",
        "elasticloadbalancing:ModifyRule"
      ],
      resources: ["*"],
      effect: iam.Effect.ALLOW
    });
    // Service account for AWS Load Balancer Controller
    const albServiceAccount = cluster.addServiceAccount('ALBServiceAccount', {
      namespace: 'infrastructure',
      name: 'aws-load-balancer-controller'
    });
    albServiceAccount.addToPrincipalPolicy(albPolicy);
    albServiceAccount.node.addDependency(infrastructure_ns);
    albServiceAccount.node._actualNode.addDependency(infrastructure_ns);
  }
}
