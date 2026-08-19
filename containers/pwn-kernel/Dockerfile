FROM proofblade/ctf-pwn:latest

# Kernel challenges need an explicit operator-approved privileged profile; the
# runtime still drops all capabilities by default and only adds SYS_PTRACE.
CMD ["sleep", "infinity"]
