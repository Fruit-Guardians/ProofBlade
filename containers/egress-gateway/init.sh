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
