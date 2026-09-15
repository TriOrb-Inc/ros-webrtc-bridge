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

# By default, follow CONTRIBUTING.md: run npm ci and prepare the rclnodejs
# native addon in a ROS environment before colcon build. Explicit options support clean builds
# while preserving the policy against implicitly running npm lifecycle scripts.
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

# When CMake also installs npm dependencies in a clean workspace, allow explicit generation
# of the native addon and message bindings in the same build with ROS sourced.
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

# Materialize the transport before building TypeScript. The generated
# vendor/werift-datachannel/.runtime/lib is referenced by the npm file dependency.
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

# The TypeScript build includes tests, so install only the source subtree imported by
# the persistent bridge under dist/ in a stable install layout.
install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/.runtime/build/packages/bridge/src/"
  DESTINATION "${ROS_WEBRTC_BRIDGE_LIB_DIR}/dist"
  FILES_MATCHING
    PATTERN "*.js"
    PATTERN "*.js.map"
)

# Preserve the relative layout of package manifests and vendor files. In particular,
# node_modules/@ros-webrtc/werift-datachannel -> ../../vendor/werift-datachannel
# provide the target of this npm file dependency in the install tree as well.
install(FILES package.json package-lock.json
  DESTINATION "${ROS_WEBRTC_BRIDGE_LIB_DIR}"
)
install(DIRECTORY vendor/
  DESTINATION "${ROS_WEBRTC_BRIDGE_LIB_DIR}/vendor"
  PATTERN "staging-*" EXCLUDE
)

# The default bundles the locked dependency tree used for the build because it includes
# generated rclnodejs native bindings. Set this option OFF only when dependencies are supplied
# as separate packages, such as Debian packages, and preserve module resolution in release packaging.
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
install(FILES scripts/credential-store.mjs
  DESTINATION "share/${PROJECT_NAME}/scripts"
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
