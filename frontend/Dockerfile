FROM eclipse-temurin:17-jdk-jammy

# ── System packages ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    unzip \
    git \
    ca-certificates \
    gnupg \
    adb \
    python3 \
    libglib2.0-0 \
    libglib2.0-dev \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 LTS ─────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Android SDK ────────────────────────────────────────────────────────────────
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"

RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" && \
    wget -q "https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip" \
         -O /tmp/cmdline-tools.zip && \
    unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-extracted && \
    mv /tmp/cmdline-tools-extracted/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest" && \
    rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools-extracted

# These MUST match android/build.gradle's ext block. Anything Gradle wants that
# is not baked in here gets downloaded on *every* build instead: the container
# runs with --rm and ANDROID_HOME is an image layer, not a volume, so the
# download cannot persist. The NDK alone is ~1GB, which is why the versions
# drifting out of sync costs minutes per build rather than a one-off.
RUN yes | sdkmanager --licenses > /dev/null 2>&1 && \
    sdkmanager \
        "platform-tools" \
        "platforms;android-36" \
        "build-tools;36.0.0" \
        "ndk;27.1.12297006" \
        "cmake;3.22.1"

# ── Project setup ──────────────────────────────────────────────────────────────
WORKDIR /app

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY . .

EXPOSE 8081

CMD ["npm", "run", "start", "--", "--host", "0.0.0.0"]
