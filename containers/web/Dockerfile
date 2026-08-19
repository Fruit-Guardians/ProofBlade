FROM proofblade/ctf-base:latest

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
