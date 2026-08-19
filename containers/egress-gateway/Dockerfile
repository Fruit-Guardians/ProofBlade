FROM alpine:3.20

RUN apk add --no-cache iptables ip6tables iproute2 ca-certificates
COPY init.sh /usr/local/bin/pb-egress-init
RUN chmod 0755 /usr/local/bin/pb-egress-init
ENTRYPOINT ["sleep", "infinity"]
