cmake_minimum_required(VERSION 3.16)
project(ros_webrtc_bridge)

include(CTest)
find_package(ament_cmake REQUIRED)

option(
  ROS_WEBRTC_BRIDGE_RUN_NPM_INSTALL
  "Run npm ci in offline mode before preparing and building the bridge"
  OFF
)
option(
  ROS_WEBRTC_BRIDGE_INSTALL_NODE_MODULES
  "Install the repository-local Node.js dependency tree with the bridge"
  ON
)
option(
  ROS_WEBRTC_BRIDGE_RUN_RCLNODEJS_REBUILD
  "Rebuild the rclnodejs native addon in the sourced ROS environment"
  OFF
)
option(
  ROS_WEBRTC_BRIDGE_RUN_NPM_TEST
  "Register npm test with CTest/colcon test"
  ON
)

find_program(NPM_EXECUTABLE npm)
if(NOT NPM_EXECUTABLE)
  message(FATAL_ERROR "npm was not found. Install Node.js/npm before building ros_webrtc_bridge.")
endif()

# 既定では CONTRIBUTING.md の手順どおり、ROS 環境内で npm ci と rclnodejs の
# native 準備を済ませてから colcon build する。明示 option は clean build 用で、
# npm lifecycle script を暗黙実行しない既存方針を維持する。
if(ROS_WEBRTC_BRIDGE_RUN_NPM_INSTALL)
  add_custom_target(ros_webrtc_bridge_npm_install ALL
    COMMAND ${NPM_EXECUTABLE} ci --ignore-scripts --offline --no-audit --no-fund
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    COMMENT "Installing cached, locked Node.js dependencies for ros_webrtc_bridge without network access"
    VERBATIM
  )
elseif(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/node_modules")
  message(FATAL_ERROR
    "node_modules was not found. Run npm ci --ignore-scripts first, or configure "
    "with -DROS_WEBRTC_BRIDGE_RUN_NPM_INSTALL=ON after preloading the npm cache. Prepare rclnodejs in the sourced "
    "ROS environment before running the installed bridge."
  )
endif()

# clean workspace で npm install も CMake に任せる場合は、ROS を source した同じ
# build で native addon と message binding も明示生成できるようにする。
if(ROS_WEBRTC_BRIDGE_RUN_RCLNODEJS_REBUILD)
  add_custom_target(ros_webrtc_bridge_rclnodejs_rebuild ALL
    COMMAND ${NPM_EXECUTABLE} rebuild rclnodejs --foreground-scripts
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    COMMENT "Rebuilding rclnodejs for the active ROS environment"
    VERBATIM
  )
  if(TARGET ros_webrtc_bridge_npm_install)
    add_dependencies(ros_webrtc_bridge_rclnodejs_rebuild ros_webrtc_bridge_npm_install)
  endif()
elseif(ROS_WEBRTC_BRIDGE_RUN_NPM_INSTALL)
  message(WARNING
    "npm ci is enabled without the rclnodejs rebuild. The TypeScript build can "
    "complete, but the installed ROS bridge is not runnable until rclnodejs is "
    "rebuilt in the target ROS environment."
  )
endif()

# transport の materialize は TypeScript build より先に行う。生成された
# vendor/werift-datachannel/.runtime/lib は npm の file dependency が参照する。
add_custom_target(ros_webrtc_bridge_prepare_transport ALL
  COMMAND ${NPM_EXECUTABLE} run prepare:transport
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  COMMENT "Preparing the integrity-pinned WebRTC DataChannel transport"
  VERBATIM
)
if(TARGET ros_webrtc_bridge_rclnodejs_rebuild)
  add_dependencies(ros_webrtc_bridge_prepare_transport ros_webrtc_bridge_rclnodejs_rebuild)
elseif(TARGET ros_webrtc_bridge_npm_install)
  add_dependencies(ros_webrtc_bridge_prepare_transport ros_webrtc_bridge_npm_install)
endif()

add_custom_target(ros_webrtc_bridge_typescript_build ALL
  COMMAND ${NPM_EXECUTABLE} run build
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  COMMENT "Building the ros_webrtc_bridge TypeScript runtime"
  VERBATIM
)
add_dependencies(ros_webrtc_bridge_typescript_build ros_webrtc_bridge_prepare_transport)

set(ROS_WEBRTC_BRIDGE_LIB_DIR "lib/${PROJECT_NAME}")

# TypeScript build には test も含まれるため、常駐 bridge が import する source subtree
# だけを安定した install layout の dist/ へ配置する。
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/.runtime/build/packages/bridge/src/"
  DESTINATION "${ROS_WEBRTC_BRIDGE_LIB_DIR}/dist"
  FILES_MATCHING
    PATTERN "*.js"
    PATTERN "*.js.map"
)

# package manifests と vendor の相対配置を維持する。特に
# node_modules/@ros-webrtc/werift-datachannel -> ../../vendor/werift-datachannel
# という npm file dependency のリンク先を install tree にも用意する。
install(FILES package.json package-lock.json
  DESTINATION "${ROS_WEBRTC_BRIDGE_LIB_DIR}"
)
install(DIRECTORY vendor/
  DESTINATION "${ROS_WEBRTC_BRIDGE_LIB_DIR}/vendor"
  PATTERN "staging-*" EXCLUDE
)

# rclnodejs の生成済み native binding を含むため、既定では build に使用した locked
# dependency tree を同梱する。Debian 等で依存を別 package として供給する場合だけ
# OFF にし、同じ module 解決位置を release packaging 側で提供する。
if(ROS_WEBRTC_BRIDGE_INSTALL_NODE_MODULES)
  install(DIRECTORY node_modules/
    DESTINATION "${ROS_WEBRTC_BRIDGE_LIB_DIR}/node_modules"
  )
endif()

install(PROGRAMS scripts/ros_webrtc_bridge
  DESTINATION "${ROS_WEBRTC_BRIDGE_LIB_DIR}"
)
install(DIRECTORY examples
  DESTINATION "share/${PROJECT_NAME}"
)
install(DIRECTORY launch
  DESTINATION "share/${PROJECT_NAME}"
)
install(FILES LICENSE
  DESTINATION "share/${PROJECT_NAME}"
)

if(BUILD_TESTING AND ROS_WEBRTC_BRIDGE_RUN_NPM_TEST)
  add_test(
    NAME ros_webrtc_bridge_npm_test
    COMMAND ${NPM_EXECUTABLE} test
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  )
  set_tests_properties(ros_webrtc_bridge_npm_test PROPERTIES TIMEOUT 600)
  add_test(
    NAME ros_webrtc_bridge_package_contract
    COMMAND ${NPM_EXECUTABLE} run test:packaging:contract
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  )
  set_tests_properties(ros_webrtc_bridge_package_contract PROPERTIES TIMEOUT 30)
endif()

ament_package()
