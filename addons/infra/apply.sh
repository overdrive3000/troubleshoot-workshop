#!/bin/bash +x

# variables
context="infra"
declare -A repos=( ["metrics-server"]="https://charts.bitnami.com/bitnami,infrastructure" ["aws-load-balancer-controller"]="https://aws.github.io/eks-charts,infrastructure" ["cluster-autoscaler"]="https://kubernetes.github.io/autoscaler,infrastructure" ["aws-ebs-csi-driver"]="https://kubernetes-sigs.github.io/aws-ebs-csi-driver,infrastructure" ["litmus"]="https://litmuschaos.github.io/litmus-helm/,litmus" ["kube-ops-view"]="https://charts.helm.sh/stable,monitoring" ["kube-prometheus-stack"]="https://prometheus-community.github.io/helm-charts,monitoring" )

# Install helm charts
for name in "${!repos[@]}"; do
  IFS="," read -a value <<< "${repos[${name}]}"
  # Add helm repos
  helm --kube-context "${context}" repo add "${name}" "${value[0]}";

  # Install helm charts, litmus will be installed just once
  case ${name} in
    "litmus")
      if ! helm --kube-context "${context}" status -n ${name} ${name}; then
        helm --kube-context "${context}" upgrade -i "${name}" "${name}/${name}" -n "${value[1]}" -f "./$name/values.yaml";
      fi
      ;;
    *)
      echo "Installing ${name}";
      echo "";
      helm --kube-context "${context}" upgrade -i "${name}" "${name}/${name}" -n "${value[1]}" -f "./$name/values.yaml";
      ;;
  esac
done

