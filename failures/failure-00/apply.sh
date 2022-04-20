#!/bin/bash

echo "Install RBAC"
kubectl apply -f rbac.yaml

echo "Install failure"
kubectl apply -f failure.yaml
