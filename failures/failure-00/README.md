# Failure 00

## Simulate an application bug

Run following command:

```
kubectl -n sock-shop set image deployment/front-end front-end=public.ecr.aws/j8e3t3x0/front-end:0.3.13
```

## Check deployment status

Deployment status can be seen using `kube-ops-view` or `lens`. Using kubectl run:

```
kubectl -n sock-shop rollout status deployment/front-end
```

## Rollback change

Apply rollback

```
kubectl -n sock-shop rollout undo deployment/front-end
```