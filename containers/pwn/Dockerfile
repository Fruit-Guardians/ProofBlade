FROM proofblade/ctf-base:latest

# Keep exploit transcripts deterministic on the Windows/Docker Desktop path.
# Python otherwise inherits a locale that may be GBK and can fail while
# printing a UTF-8 banner or shell marker, hiding the real interaction error.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8 \
    HOME=/home/ctf \
    XDG_CACHE_HOME=/home/ctf/.cache \
    XDG_DATA_HOME=/home/ctf/.local/share \
    PWNLIB_NOTERM=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    clang cmake gcc gcc-multilib gdb gdb-multiarch libc6-dbg nasm patchelf qemu-system-x86 qemu-user qemu-user-static \
    binutils elfutils lib32z1-dev libseccomp-dev ltrace ruby \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --break-system-packages --no-cache-dir \
    pwncli pwntools ropgadget
RUN gem install --no-document one_gadget || true
USER ctf
CMD ["sleep", "infinity"]
