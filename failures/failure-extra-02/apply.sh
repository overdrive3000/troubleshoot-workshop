#!/bin/bash

echo "Trying to inject failure"

INSTANCE_ID=$(kubectl get node -l nodegroup-role=web-workload -o jsonpath="{.items[0].spec.providerID}" | cut -d '/' -f 5)
aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "Injecting failure-02" \
  --parameters 'commands=["sudo amazon-linux-extras install epel -y", "sudo yum install stress-ng -y", "sudo stress-ng --vm 1 --vm-bytes 6511844k --timeout 15m"]'
