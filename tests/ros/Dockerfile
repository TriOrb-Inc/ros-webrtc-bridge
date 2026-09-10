ARG ROS_IMAGE=ros:jazzy-ros-base-noble
FROM node:22.22.2-bookworm-slim AS node
FROM ${ROS_IMAGE}

# 公式Node binaryを使い、host上のROSとnpm成果物を取り込まない。
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /bridge
COPY package.json package-lock.json tsconfig.json .c8rc.json ./
COPY vendor ./vendor
# native installはROS environmentをsourceした後の専用工程へ分離する。
RUN echo 'npm dependency resolution may be silent; bounded to 180 seconds' && \
    timeout 180 npm ci --ignore-scripts && node vendor/werift-datachannel/materialize.mjs

# ROS baseにはbuild toolsと標準interfaceが含まれる。native rebuildは最大10分。
SHELL ["/bin/bash", "-c"]
RUN source /opt/ros/${ROS_DISTRO}/setup.bash && \
    echo 'rclnodejs install and interface generation may be silent; bounded to 600 seconds' && \
    timeout 600 npm rebuild rclnodejs --foreground-scripts
COPY packages ./packages
COPY tests ./tests
COPY examples ./examples
RUN npm run build

# 対向nodeやgatewayはrun時に明示する。jobごとにDocker networkを作りhost networkは使わない。
ENV RMW_IMPLEMENTATION=rmw_fastrtps_cpp
CMD ["bash", "-lc", "source /opt/ros/${ROS_DISTRO}/setup.bash && python3 /bridge/tests/ros/peer.py"]
