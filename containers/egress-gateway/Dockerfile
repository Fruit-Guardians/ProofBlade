FROM alpine:3.20

RUN apk add --no-cache iptables ip6tables iproute2 ca-certificates
COPY init.sh /usr/local/bin/pb-egress-init
# Git on Windows may materialize shell scripts with CRLF.  Normalize the
# interpreter file inside the image so exec works consistently on Docker
# Desktop and native Linux hosts.
RUN sed -i 's/\r$//' /usr/local/bin/pb-egress-init && chmod 0755 /usr/local/bin/pb-egress-init
ENTRYPOINT ["sleep", "infinity"]
