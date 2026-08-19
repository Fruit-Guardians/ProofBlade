#!/bin/sh
set -eu

# The solver container joins this network namespace. Default DROP is the
# fail-closed boundary; only loopback, established flows, DNS and the resolved
# challenge host:port pairs are permitted.
iptables -F OUTPUT
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

for target in "$@"; do
  address="${target%:*}"
  port="${target##*:}"
  case "$address" in
    *.*) iptables -A OUTPUT -p tcp -d "$address" --dport "$port" -j ACCEPT ;;
  esac
done
