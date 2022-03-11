#!/bin/bash

echo "Installing chaos experiments in multiple namespaces"

kubectl apply -n litmus -f experiments.yaml
kubectl apply -n kube-system -f experiments.yaml
kubectl apply -n sock-shop -f experiments.yaml