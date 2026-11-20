FROM python:3.11.11-slim-bookworm@sha256:081075da77b2b55c23c088251026fb69a7b2bf92471e491ff5fd75c192fd38e5 AS core
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates file binutils gdb gdbserver strace ltrace jq unzip zip xxd netcat-openbsd nmap openssl patchelf sqlite3 tcpdump tshark git make gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends \
    binwalk bzip2 cpio dnsutils foremost g++ iproute2 libimage-exiftool-perl \
    nasm p7zip-full pngcheck ripgrep socat steghide unrar-free wget xz-utils zstd \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends \
    bsdextrautils hashid \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends \
    imagemagick ncat poppler-utils qpdf yara \
    && rm -rf /var/lib/apt/lists/*
FROM core AS reverse-assets
ADD --checksum=sha256:0dddf90e217e38a6a658881b9ec7e217198487c75b7f82a332b3cbd30834636f https://github.com/radareorg/radare2/releases/download/6.2.6/radare2_6.2.6_amd64.deb /tmp/radare2.deb
ADD --checksum=sha256:1755e4242ade71a077438723689f404079592ec7764a3a0572f98fef94ebcbf3 https://github.com/skylot/jadx/releases/download/v1.5.7/jadx-1.5.7.zip /tmp/jadx.zip
RUN dpkg-deb -x /tmp/radare2.deb /opt/radare2 && mkdir -p /opt/jadx \
    && unzip -q /tmp/jadx.zip -d /opt/jadx && rm /tmp/radare2.deb /tmp/jadx.zip
FROM core AS jdk-assets
ADD --checksum=sha256:760f91b22c3efc9bd1b64ff950598231be82928cc807e30691a0e7a2995a62c0 https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5.1%2B2/OpenJDK25U-jdk_x64_linux_hotspot_25.0.5.1_2.tar.gz /tmp/jdk.tar.gz
RUN mkdir -p /opt/jdk && tar -xzf /tmp/jdk.tar.gz -C /opt/jdk --strip-components=1 && rm /tmp/jdk.tar.gz
FROM core AS ghidra-assets
RUN apt-get update && apt-get install -y --no-install-recommends aria2 && rm -rf /var/lib/apt/lists/*
RUN aria2c --max-connection-per-server=8 --split=8 --min-split-size=8M --file-allocation=none \
    --max-tries=5 --retry-wait=5 --dir=/tmp --out=ghidra.zip \
    https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.2_build/ghidra_12.2_PUBLIC_20261016.zip \
    && echo '2c2cd776db3c1f6a097ba418922378ac3649cadd5e844a6f5f088ae628a7be67  /tmp/ghidra.zip' | sha256sum -c - \
    && unzip -q /tmp/ghidra.zip -d /opt && mv /opt/ghidra_12.2_PUBLIC /opt/ghidra && rm /tmp/ghidra.zip
FROM core AS extended-assets
ADD --checksum=sha256:9102249a9f0b6319c5334a2e5cf8d9cc3f2035e1d3def027c41f6a90f647e8cf https://github.com/rizinorg/rizin/releases/download/v0.9.1/rizin-v0.9.1-static-x86_64.tar.xz /tmp/rizin.tar.xz
ADD --checksum=sha256:17049a23ba8cbcf4780c4bc9b4aeb519f2801ceabe7304b55d3d622acca03b8c https://github.com/pwndbg/pwndbg/releases/download/2026.10.28/pwndbg_2026.10.28_x86_64-portable.tar.xz /tmp/pwndbg.tar.xz
RUN mkdir -p /opt/rizin /opt/pwndbg \
    && tar -xJf /tmp/rizin.tar.xz -C /opt/rizin \
    && tar -xJf /tmp/pwndbg.tar.xz -C /opt
FROM core AS solver
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
    apktool ffmpeg gcc-mingw-w64-i686 gcc-mingw-w64-x86-64 wine wine64 wine32:i386 \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffuf gdb-multiarch qemu-user ruby sleuthkit sqlmap \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; cd /tmp; \
    for spec in 'iostruct-0.7.0:e93f2ffea3b79a0e1045f0e0bd3f202368d89c53b692878e693cf50603bae49c' \
                'rainbow-3.1.1:039491aa3a89f42efa1d6dec2fc4e62ede96eb6acd95e52f1ad581182b79bc6a' \
                'zpng-0.4.6:40f4629f7dac4864662fa5cdfe7b410cc4bc8e72e271d39551f084291e64246e' \
                'zsteg-0.2.14:761ee35a8512630606946187ed1a3150c6ab30dd5e32cefe48ebb2b874190f6f'; do \
      name="${spec%%:*}"; digest="${spec#*:}"; \
      curl -fL --retry 3 -o "$name.gem" "https://rubygems.org/downloads/$name.gem"; \
      echo "$digest  $name.gem" | sha256sum -c -; \
      gem install --local --ignore-dependencies --no-document "$name.gem"; \
      rm "$name.gem"; \
    done
RUN python -m venv /opt/semgrep && /opt/semgrep/bin/pip install --no-cache-dir semgrep==1.120.0 \
    && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep
COPY requirements-extras.txt /tmp/requirements-extras.txt
RUN pip install --no-cache-dir --no-deps --no-build-isolation --require-hashes -r /tmp/requirements-extras.txt && rm /tmp/requirements-extras.txt
COPY --from=jdk-assets /opt/jdk /opt/jdk
COPY --from=ghidra-assets /opt/ghidra /opt/ghidra
COPY --from=reverse-assets /opt/radare2/usr /usr
COPY --from=reverse-assets /opt/jadx /opt/jadx
RUN ln -s /usr/lib/wine/wine64 /usr/local/bin/wine64
ENV HOME=/work WINEPREFIX=/work/.wine WINEDEBUG=-all
COPY ghidra-headless-wrapper.sh /usr/local/bin/analyzeHeadless
COPY jadx-wrapper.sh /usr/local/bin/jadx
RUN chmod 0755 /usr/local/bin/analyzeHeadless /usr/local/bin/jadx && ldconfig
WORKDIR /work
CMD ["sleep", "infinity"]

# Keep new layers after the existing toolchain so upgrading reuses its build cache.
RUN apt-get update && apt-get install -y --no-install-recommends \
    sagemath john hashcat pocl-opencl-icd clinfo libpcap0.8 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements-tooling.txt /tmp/requirements-tooling.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements-tooling.txt \
    && rm /tmp/requirements-tooling.txt
COPY requirements-angr.txt /tmp/requirements-angr.txt
RUN python3 -m venv /opt/angr \
    && /opt/angr/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements-angr.txt \
    && /opt/angr/bin/python -c 'import angr, claripy; print(angr.__version__)' \
    && rm /tmp/requirements-angr.txt
COPY --from=extended-assets /opt/rizin /opt/rizin
COPY --from=extended-assets /opt/pwndbg /opt/pwndbg
COPY sage-wrapper.sh /usr/local/bin/sage
COPY pwndbg-wrapper.sh /usr/local/bin/pwndbg
COPY angr-python-wrapper.sh /usr/local/bin/angr-python
COPY ctf-decompile.py /usr/local/bin/ctf-decompile
COPY ghidra/ExportFunctions.java /opt/ctf-ghidra/ExportFunctions.java
COPY tool-guide.md /opt/ctf-tools/README.md
COPY smoke-extended.sh /opt/ctf-tools/smoke-extended.sh
COPY with-user.py /opt/ctf-tools/with-user
RUN apt-get update && apt-get install -y --no-install-recommends libnss-wrapper \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /opt/ctf-tools/with-user /usr/local/bin/hashcat \
    && ln -s /opt/ctf-tools/with-user /usr/local/bin/john \
    && chmod 0755 /opt/ctf-tools/with-user
RUN for tool in /opt/rizin/bin/*; do ln -s "$tool" "/usr/local/bin/$(basename "$tool")"; done \
    && chmod 0755 /usr/local/bin/sage /usr/local/bin/pwndbg /usr/local/bin/angr-python /usr/local/bin/ctf-decompile
# Solvers use the operator's numeric UID, which need not have an /etc/passwd entry.
ENV GHIDRA_HOME=/opt/ghidra MPLBACKEND=Agg TERM=xterm-256color USER=solver LOGNAME=solver
