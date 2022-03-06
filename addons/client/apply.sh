#!/bin/bash +x

# variables
context="client"
namespace="infrastructure"
declare -A repos=( ["cluster-autoscaler"]="https://kubernetes.github.io/autoscaler" )

# Install helm charts
for name in "${!repos[@]}"; do
  echo "Installing ${name}";
  echo "";
  helm --kube-context "${context}" repo add "${name}" "${repos[${name}]}";
  helm --kube-context "${context}" upgrade -i "${name}" "${name}/${name}" -n "${namespace}" -f "./$name/values.yaml";
done
