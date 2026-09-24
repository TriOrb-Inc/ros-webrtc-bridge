ARG ROS_IMAGE=ros:jazzy-ros-base-noble
FROM node:22.22.2-bookworm-slim AS node
FROM ${ROS_IMAGE}

SHELL ["/bin/bash", "-c"]

# Use official Node binaries without importing host ROS or npm artifacts.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# GStreamer and its Python bindings are the media worker's runtime. They are host dependencies of a
# deployment, not bundled by this project, so the test image installs them exactly as an operator would.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
      gstreamer1.0-tools python3-gi gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 && \
    rm -rf /var/lib/apt/lists/*

# Add the test-only implementation only in Cyclone test images that change RMW from the Fast DDS baseline.
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
# Perform native installation in a dedicated step after sourcing the ROS environment.
RUN echo 'npm dependency resolution may be silent; bounded to 180 seconds' && \
    timeout 180 npm ci --ignore-scripts && node vendor/werift-datachannel/materialize.mjs

# Build a test interface overlay independent of the core package first, exercising successful dynamic type loading.
COPY tests/ros/interfaces/bridge_test_interfaces /bridge/test_interfaces/src/bridge_test_interfaces
RUN source /opt/ros/${ROS_DISTRO}/setup.bash && \
    cd /bridge/test_interfaces && \
    colcon build --packages-select bridge_test_interfaces --event-handlers console_direct+

# The ROS base includes build tools and standard interfaces. Native rebuilds have a ten-minute limit.
RUN source /opt/ros/${ROS_DISTRO}/setup.bash && \
    source /bridge/test_interfaces/install/setup.bash && \
    echo 'rclnodejs install and interface generation may be silent; bounded to 600 seconds' && \
    timeout 600 npm rebuild rclnodejs --foreground-scripts
COPY packages ./packages
COPY tests ./tests
COPY examples ./examples
COPY launch ./launch
COPY scripts ./scripts
COPY worker ./worker
RUN npm run build

# Connection-test Gateways use only colcon-installed artifacts, never direct source-tree startup.
RUN mkdir -p /bridge/package_workspace/src/ros_webrtc_bridge && \
    tar --exclude='./.runtime' --exclude='./test_interfaces' --exclude='./package_workspace' \
      -C /bridge -cf - . | tar -C /bridge/package_workspace/src/ros_webrtc_bridge -xf - && \
    source /opt/ros/${ROS_DISTRO}/setup.bash && \
    source /bridge/test_interfaces/install/setup.bash && \
    cd /bridge/package_workspace && \
    colcon build --packages-select ros_webrtc_bridge --event-handlers console_direct+

# Specify peers and Gateways at run time. Create a Docker network per job; do not use host networking.
ENV RMW_IMPLEMENTATION=${BRIDGE_RMW_IMPLEMENTATION}
CMD ["bash", "-lc", "source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/test_interfaces/install/setup.bash && python3 /bridge/tests/ros/peer.py"]
