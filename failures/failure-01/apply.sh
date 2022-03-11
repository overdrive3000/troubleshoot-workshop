#!/bin/bash

echo "Install RBAC"
kubectl apply -n litmus -f rbac.yaml

echo "Install failure"
kubectl apply -n litmus -f failure.yaml