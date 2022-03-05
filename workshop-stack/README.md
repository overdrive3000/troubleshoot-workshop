# EKS lab cluster CloudFormation stack setup
# For use with Event Engine

This directory contains a CDK application that provisions a fully-complete
EKS workshop environment via Event Engine. The components include:

* VPC with public/private subnets, an Internet Gateway, and NAT Gateway
* Cloud9 EC2 environment
* EKS cluster
* All the wiring needed to make things work without configuration on the
  attendee's part:
  * Security group access to K8S API
  * SSH access to nodes
  * kubeconfig already configured to access the cluster
  * S3 bucket for forensics, with bucket name exposed via `$FORENSICS_S3_BUCKET`
    environment variable

At the time of writing, Event Engine only supports YAML CloudFormation templates
for automating the post-provisioning of team AWS accounts. This poses some
challenges because the built-in CloudFormation resource providers are
insufficient for our needs. We need to provision a complex stack that contains
Lambda functions and Custom Resources in order to have everything nicely wired
up, so that the participant has to do very little upon accessing the AWS account
and entering the console. Also, CDK has some very convenient L2 constructs that
make it very easy to create Custom Resources, configure EKS cluster
authentication and install K8S objects and Helm charts into the cluster.

To work around this issue, we divided the stack into two stacks:
`BootstrapStack` and `ClusterStack`. Although both are CDK stacks, the former is
much simpler than the latter.

`BootstrapStack` has no Lambda functions other than inline functions, and can be
synthesized (compiled) via `cdk synth` into a stack template that can be copied
and pasted directly into the EventEngine console. It doesn't require any
external resources such as S3 objects.  `BootstrapStack` is responsible for
creating the VPC and its components and setting up the Cloud9 environment.
Finally, `BootstrapStack` creates a Custom Resource that provisions the second,
more complicated `ClusterStack`.

`ClusterStack` is the stack that provisions most of the resources needed to set
up the lab. It creates the EKS cluster and nodes, and handles most of the
automation needed so that the Cloud9 workspace is immediately able to use the
cluster and run `kubectl` commands without any additional configuration or
software installation. This includes security group configuration, IAM role
configuration on the Cloud9 instance, SSH key creation and deployment,
installation of the `kubectl` tool, and kubeconfig setup. `ClusterStack` relies
heavily on CDK L2 constructs that involve creating Lambda functions and custom
resources under the hood.

Since we can't use CDK apps directly with Event Engine, we introduce a clever
level of indirection: `ClusterStack` is provisioned by AWS CodeBuild.

To do this, we build a Zip file containing this repository and upload it to the
S3 bucket provided by Event Engine. Event Engine then supplies `BootstrapStack`
with the bucket location and prefix as parameters during stack creation. The
bucket and path of the Zip file are given to the CodeBuild project, and the
included `buildspec.yml` tells CodeBuild how to install `ClusterStack`. Then,
`BootstrapStack` invokes CodeBuild as a Custom Resource.

## Prerequisites

1. You'll need some recent version of NodeJS installed (we tested with 14.x).
2. Run `npm install` in this directory to install all the dependencies.
3. Ensure `AWS_REGION` is set to the deployment region.
4. Ensure `AWS_ACCOUNT_ID` is set to the deployment account ID.

## How do I set this up with Event Engine?

1. See "Prerequisites" above.
2. Obtain the IAM credentials, S3 bucket and prefix from [Event
   Engine](https://admin.eventengine.run). It'll be in the Assets tab of your
   module. Modules are versioned, so be sure to choose the version of the module
   you'll be deploying.
3. In your shell, set the environment variables as given in the credentials.
4. Run `S3_ASSET_BUCKET=<bucketname> S3_ASSET_PREFIX=<prefix> make upload`.
   Note, the asset prefix **should not** start with `/` and **should** end with
   `/`. For example,
   `S3_ASSET_PREFIX=modules/86c1e0c3c6334833a734a3e21fa4e009/v1/`.
5. Synthesize the bootstrap stack: `make synth-bootstrap`. Then copy the content
   of `cdk.out/BootstrapStack.template.json` into the module's Team Template.
6. Under the IAM tab of the module configuration, in the "IAM Managed Policy
   ARNs" box, enter `arn:aws:iam::aws:policy/PowerUserAccess` as the managed
   policy ARN.
7. Save the module configuration.
8. Create a blueprint using the module.
9. Create an event from the blueprint.

## How can I test this in my own Isengard account?

1. See "Prerequisites" above.
2. Create an S3 bucket for the Zip file in your Isengard account. It needs to be
   in the same region as where you intend to deploy the stacks:
   `aws s3 mb <bucket-name> --region <region>`
3. Deploy the stack and 🙏: `make S3_ASSET_BUCKET=<bucket-name> S3_ASSET_PREFIX= deploy`
4. Log into the provisioned Cloud9 Environment.
5. **Disable AWS managed credentials in the Preferences.** (We haven't been able
   to successfully automate this yet.)
6. Try running `kubectl get node`. A list of nodes should be returned.

## Issues and Notes

* In the Cloud9 console, the Cloud9 environment will appear in the "Shared
  with you" tab, not "Your environments."
* During testing, you must manually disable AWS managed credentials in your
  Cloud9 IDE. We haven't figured out a way to automatically disable it just
  yet. Help wanted!

## I have questions.

Email <fiscmi@amazon.com> or <umishaq@amazon.com>. Supported on a best-effort basis.