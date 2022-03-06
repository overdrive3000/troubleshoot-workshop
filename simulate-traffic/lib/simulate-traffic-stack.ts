import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as iam from '@aws-cdk/aws-iam';

export interface SimulateTrafficStackProps extends cdk.StackProps {
  loadBalancerUrl: string
  numReplicas: number
}

export class SimulateTrafficStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: SimulateTrafficStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
      isDefault: true
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc
    });

    //const execRole = new iam.Role(this, 'ExecRole', {
    //  assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    //})
    //execRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonECSTaskExecutionRolePolicy'))

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      //executionRole: execRole,
      cpu: 512,
      memoryLimitMiB: 1024
    });
    taskDef.addContainer('TrafficGenerator', {
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/j8e3t3x0/load-test:0.1.1"),
      memoryLimitMiB: 1024,
      cpu: 512,
      entryPoint: [
        "/bin/sh"
      ],
      command: [
        "-c",
        `while true; do locust --host ${props?.loadBalancerUrl} -f /config/locustfile.py --clients 4 --hatch-rate 5 --num-request 10 --no-web; done`
      ],
    });

    new ecs.FargateService(this, 'Service', {
      cluster: cluster,
      taskDefinition: taskDef,
      desiredCount: props?.numReplicas 
    });
  }
}
