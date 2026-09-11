ARG ROS_IMAGE=ros:jazzy-ros-base-noble
FROM node:22.22.2-bookworm-slim AS node
FROM ${ROS_IMAGE}

SHELL ["/bin/bash", "-c"]

# 公式Node binaryを使い、host上のROSとnpm成果物を取り込まない。
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Fast DDS基準からRMWだけを変えるCyclone試験imageに限り、test-only実装を追加する。
ARG BRIDGE_RMW_IMPLEMENTATION=rmw_fastrtps_cpp
RUN if [[ "${BRIDGE_RMW_IMPLEMENTATION}" == "rmw_cyclonedds_cpp" ]]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends "ros-${ROS_DISTRO}-rmw-cyclonedds-cpp" && \
      rm -rf /var/lib/apt/lists/*; \
    elif [[ "${BRIDGE_RMW_IMPLEMENTATION}" != "rmw_fastrtps_cpp" ]]; then \
      echo 'unsupported BRIDGE_RMW_IMPLEMENTATION' >&2; exit 2; \
    fi

WORKDIR /bridge
COPY package.json package-lock.json tsconfig.json .c8rc.json ./
COPY package.xml CMakeLists.txt LICENSE ./
COPY vendor ./vendor
# native installはROS environmentをsourceした後の専用工程へ分離する。
RUN echo 'npm dependency resolution may be silent; bounded to 180 seconds' && \
    timeout 180 npm ci --ignore-scripts && node vendor/werift-datachannel/materialize.mjs

# core packageから独立したtest interface overlayを先に作り、動的型の成功経路を検証する。
COPY tests/ros/interfaces/bridge_test_interfaces /bridge/test_interfaces/src/bridge_test_interfaces
RUN source /opt/ros/${ROS_DISTRO}/setup.bash && \
    cd /bridge/test_interfaces && \
    colcon build --packages-select bridge_test_interfaces --event-handlers console_direct+

# ROS baseにはbuild toolsと標準interfaceが含まれる。native rebuildは最大10分。
RUN source /opt/ros/${ROS_DISTRO}/setup.bash && \
    source /bridge/test_interfaces/install/setup.bash && \
    echo 'rclnodejs install and interface generation may be silent; bounded to 600 seconds' && \
    timeout 600 npm rebuild rclnodejs --foreground-scripts
COPY packages ./packages
COPY tests ./tests
COPY examples ./examples
COPY launch ./launch
COPY scripts ./scripts
RUN npm run build

# 接続試験のGatewayはsource treeを直接起動せず、colcon install済みartifactだけを使う。
RUN mkdir -p /bridge/package_workspace/src/ros_webrtc_bridge && \
    tar --exclude='./.runtime' --exclude='./test_interfaces' --exclude='./package_workspace' \
      -C /bridge -cf - . | tar -C /bridge/package_workspace/src/ros_webrtc_bridge -xf - && \
    source /opt/ros/${ROS_DISTRO}/setup.bash && \
    source /bridge/test_interfaces/install/setup.bash && \
    cd /bridge/package_workspace && \
    colcon build --packages-select ros_webrtc_bridge --event-handlers console_direct+

# 対向nodeやgatewayはrun時に明示する。jobごとにDocker networkを作りhost networkは使わない。
ENV RMW_IMPLEMENTATION=${BRIDGE_RMW_IMPLEMENTATION}
CMD ["bash", "-lc", "source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/test_interfaces/install/setup.bash && python3 /bridge/tests/ros/peer.py"]
