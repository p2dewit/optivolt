FROM debian:13-slim AS builder
ARG HIGHS_VERSION=v1.15.1
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake git nlohmann-json3-dev libz-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${HIGHS_VERSION}" --recurse-submodules \
    https://github.com/ERGO-Code/HiGHS.git /src/HiGHS
WORKDIR /src/bridge
COPY CMakeLists.txt solver.cpp ./
RUN cmake -S . -B /build -DHIGHS_SOURCE_DIR=/src/HiGHS \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/out \
    && cmake --build /build --parallel 2 \
    && install -D /build/highs-native-bridge /out/bin/highs-native-bridge

FROM debian:13-slim
COPY --from=builder /out/bin/highs-native-bridge /out/highs-native-bridge
CMD ["/out/highs-native-bridge", "--version"]
