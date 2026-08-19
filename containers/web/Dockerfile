FROM proofblade/ctf-base:latest

# Chinese CTF platforms serve UTF-8 or GBK page bodies and error messages, and
# the web tools we invoke here (curl, python-requests, sqlmap, playwright) all
# emit stdout as text. If Python falls back to ASCII stdout it truncates the
# very evidence the agent needs, so pin the same UTF-8 stack the pwn image uses.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium libnss3-dev nodejs npm php-cli ruby-full sqlmap \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --break-system-packages --no-cache-dir \
    requests beautifulsoup4 pwntools playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN mkdir -p /opt/playwright-browsers && \
    python3 -m playwright install --with-deps chromium && \
    chmod -R a+rX /opt/playwright-browsers
USER ctf
CMD ["sleep", "infinity"]
