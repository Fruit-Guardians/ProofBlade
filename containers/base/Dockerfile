FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl file git jq less netcat-openbsd python3 python3-pip \
    procps socat strace tmux unzip vim-tiny wget xxd && \
    rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1001 --shell /bin/bash ctf && mkdir -p /workspace && chown -R ctf:ctf /workspace /home/ctf
WORKDIR /workspace
CMD ["sleep", "infinity"]
