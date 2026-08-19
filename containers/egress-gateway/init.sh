#!/bin/sh
set -eu

# The solver container joins this network namespace. Default DROP is the
# fail-closed boundary; only loopback, established flows, DNS and the resolved
# challenge host:port pairs are permitted.
iptables -F OUTPUT
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Permit DNS only to resolvers injected into this container's resolv.conf
# (normally Docker's embedded 127.0.0.11 resolver), never to arbitrary hosts.
# Host-side target resolution happens before the gateway is created; this rule
# exists only for tools that need to resolve a challenge hostname in-container.
while read -r keyword resolver remainder; do
  [ "$keyword" = "nameserver" ] || continue
  case "$resolver" in
    ""|*[!0-9.]*) continue ;;
  esac
  iptables -A OUTPUT -p udp -d "$resolver" --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp -d "$resolver" --dport 53 -j ACCEPT
done < /etc/resolv.conf

for target in "$@"; do
  case "$target" in
    tcp:*|udp:*)
      protocol="${target%%:*}"
      endpoint="${target#*:}"
      ;;
    *)
      # Backwards-compatible form for callers from older images.
      protocol="tcp"
      endpoint="$target"
      ;;
  esac
  address="${endpoint%:*}"
  port="${endpoint##*:}"
  case "$address" in
    *.*)
      case "$protocol" in
        tcp|udp) iptables -A OUTPUT -p "$protocol" -d "$address" --dport "$port" -j ACCEPT ;;
        *) echo "unsupported target protocol: $protocol" >&2; exit 2 ;;
      esac
      ;;
  esac
done
