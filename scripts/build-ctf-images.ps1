$ErrorActionPreference = "Stop"

docker build -t proofblade/ctf-egress-gateway:latest containers/egress-gateway
docker build -t proofblade/ctf-base:latest containers/base
docker build -t proofblade/ctf-web:latest containers/web
docker build -t proofblade/ctf-pwn:latest containers/pwn
docker build -t proofblade/ctf-pwn-kernel:latest containers/pwn-kernel

Write-Host "ProofBlade CTF images are ready."
