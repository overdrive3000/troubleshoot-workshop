#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { SimulateTrafficStack } from '../lib/simulate-traffic-stack';
import { LoadBalancerURL, NumReplicas } from '../config';

const app = new cdk.App();
new SimulateTrafficStack(app, 'SimulateTrafficStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  loadBalancerUrl: LoadBalancerURL,
  numReplicas: NumReplicas
});
