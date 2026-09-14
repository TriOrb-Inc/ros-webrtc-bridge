#!/usr/bin/env bash
set -euo pipefail

package_name="ros_webrtc_bridge"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ros_distro="${ROS_DISTRO:-}"
smoke_port="${PACKAGING_SMOKE_PORT:-17443}"
packaging_domain_id="${PACKAGING_ROS_DOMAIN_ID:-75}"

# 必須環境を外部command実行前に検証します。入力はROS_DISTRO、出力はありません。
if [[ "${ros_distro}" != "humble" && "${ros_distro}" != "jazzy" ]]; then
  echo 'packaging smoke requires ROS_DISTRO=humble or ROS_DISTRO=jazzy' >&2
  exit 2
fi
if ! [[ "${smoke_port}" =~ ^[1-9][0-9]{0,4}$ ]] || (( smoke_port > 65535 )); then
  echo 'PACKAGING_SMOKE_PORT must be an integer from 1 through 65535' >&2
  exit 2
fi
if ! [[ "${packaging_domain_id}" =~ ^[0-9]{1,3}$ ]] || (( packaging_domain_id > 101 )); then
  echo 'PACKAGING_ROS_DOMAIN_ID must be an integer from 0 through 101' >&2
  exit 2
fi
export ROS_DOMAIN_ID="${packaging_domain_id}"
export ROS_LOCALHOST_ONLY=1

mkdir -p "${repo_root}/.runtime"
result_dir="$(mktemp -d "${repo_root}/.runtime/packaging-${ros_distro}-XXXXXX")"
workspace="$(mktemp -d "/tmp/ros-webrtc-packaging-${ros_distro}-XXXXXX")"
secret_dir="$(mktemp -d "/tmp/ros-webrtc-packaging-secret-${ros_distro}-XXXXXX")"
gateway_pid=''

# 起動中processと一時workspace・秘密値を必ず解放します。入力なし、出力なしです。
cleanup() {
  local status=$?
  if [[ -n "${gateway_pid}" ]] && kill -0 "${gateway_pid}" 2>/dev/null; then
    kill -TERM "${gateway_pid}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "${gateway_pid}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "${gateway_pid}" 2>/dev/null || true
  fi
  rm -rf -- "${workspace}" "${secret_dir}"
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 起動したros2 commandへTERMを送り、有限時間で終了することを確認します。
stop_gateway() {
  local name=$1
  local pid="${gateway_pid}"
  local status
  local forced=0

  kill -TERM "${pid}" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "${pid}" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "${pid}" 2>/dev/null; then
    forced=1
    kill -KILL "${pid}" 2>/dev/null || true
  fi
  set +e
  wait "${pid}"
  status=$?
  set -e
  gateway_pid=''

  if (( forced != 0 )); then
    echo "${name} did not stop within 10 seconds" >&2
    return 1
  fi
  if [[ "${status}" -ne 0 && "${status}" -ne 130 && "${status}" -ne 143 ]]; then
    echo "${name} exited unexpectedly after TERM: ${status}" >&2
    return 1
  fi
}

# commandを期限付きで実行し、同じ公開可能logを標準出力と結果directoryへ保存します。
run_logged() {
  local name=$1
  local timeout_seconds=$2
  shift 2
  echo "packaging smoke: ${name} (limit ${timeout_seconds}s)"
  timeout --kill-after=10s "${timeout_seconds}s" "$@" 2>&1 | tee "${result_dir}/${name}.log"
}

# 現在の作業treeをjob専用colcon workspaceへコピーし、hostのROS graphやbuild出力と分離します。
package_source="${workspace}/src/${package_name}"
mkdir -p "${package_source}"
echo 'packaging smoke: preparing isolated colcon workspace; dependency copy can take up to 60 seconds'
# Gitに含まれない依存・生成物をすべて除き、CMakeがlocal inputとnpm cacheだけから再構成します。
tar --anchored \
  --exclude='./.git' \
  --exclude='./.runtime' \
  --exclude='./node_modules' \
  --exclude='./build' \
  --exclude='./install' \
  --exclude='./log' \
  --exclude='./vendor/werift-datachannel/.runtime' \
  -C "${repo_root}" -cf - . | \
  tar -C "${package_source}" -xf -

# clean source契約を先に固定し、host由来のnative addonやmaterialize済みcoreによる偽陽性を防ぎます。
for relative in .runtime node_modules build install log vendor/werift-datachannel/.runtime; do
  if [[ -e "${package_source}/${relative}" ]]; then
    echo "clean source unexpectedly contains ${relative}" >&2
    exit 1
  fi
done

run_logged package-contract 30 node "${package_source}/tests/packaging/package-contract.mjs" "${package_source}"
run_logged colcon-list 30 bash -lc \
  "source '/opt/ros/${ros_distro}/setup.bash' && colcon list --base-paths '${workspace}/src'"
if ! grep -Eq "^${package_name}[[:space:]]" "${result_dir}/colcon-list.log"; then
  echo "colcon did not discover ${package_name}" >&2
  exit 1
fi

# build/testはROS package interfaceそのものを通し、npm testだけの成功で代用しません。
run_logged colcon-build 600 bash -lc \
  "source '/opt/ros/${ros_distro}/setup.bash' && cd '${workspace}' && colcon build --packages-select '${package_name}' --event-handlers console_direct+ --cmake-args -DROS_WEBRTC_BRIDGE_RUN_NPM_INSTALL=ON -DROS_WEBRTC_BRIDGE_RUN_RCLNODEJS_REBUILD=ON"
run_logged colcon-test 420 bash -lc \
  "source '/opt/ros/${ros_distro}/setup.bash' && cd '${workspace}' && colcon test --packages-select '${package_name}' --event-handlers console_direct+ && colcon test-result --verbose"

# install/setupをsourceした利用者視点でament index、entrypoint、共有fileを検査します。
install_setup="${workspace}/install/setup.bash"
run_logged package-prefix 30 bash -lc \
  "source '/opt/ros/${ros_distro}/setup.bash' && source '${install_setup}' && ros2 pkg prefix '${package_name}'"
package_prefix="$(tail -n 1 "${result_dir}/package-prefix.log")"
share_dir="${package_prefix}/share/${package_name}"
for path in \
  "${share_dir}/package.xml" \
  "${share_dir}/launch/bridge.launch.py" \
  "${share_dir}/examples/bridge.yaml" \
  "${share_dir}/examples/connection.yaml"; do
  if [[ ! -f "${path}" ]]; then
    echo "missing installed package file: ${path}" >&2
    exit 1
  fi
done
run_logged package-executables 30 bash -lc \
  "source '/opt/ros/${ros_distro}/setup.bash' && source '${install_setup}' && ros2 pkg executables '${package_name}'"
mapfile -t package_executables < <(
  awk -v package="${package_name}" '$1 == package { print $2 }' "${result_dir}/package-executables.log"
)
if [[ "${#package_executables[@]}" -ne 1 || "${package_executables[0]:-}" != "${package_name}" ]]; then
  echo "ros2 run must expose only ${package_name}; found: ${package_executables[*]:-(none)}" >&2
  exit 1
fi
run_logged launch-arguments 30 bash -lc \
  "source '/opt/ros/${ros_distro}/setup.bash' && source '${install_setup}' && ros2 launch '${package_name}' bridge.launch.py --show-args"

# package成果物へ秘密鍵・具体credentialを同梱していないことを検査します。
# 公開CA証明書にも使われる.pem拡張子だけではsecretと判定せず、内容を確認します。
if find "${package_prefix}" -type f -name '*.key' -print -quit | grep -q .; then
  echo 'installed package contains a private-key file' >&2
  exit 1
fi
if grep -R -I -E -q -m 1 -- "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|(^[[:space:]]*BRIDGE_CREDENTIAL[[:space:]]*=|[\"']BRIDGE_CREDENTIAL[\"'][[:space:]]*:)[[:space:]]*[\"']?[A-Za-z0-9+/=_-]{32,}[\"']?[[:space:]]*$" "${package_prefix}"; then
  echo 'installed package contains secret material' >&2
  exit 1
fi

# credentialとTLS materialはjob専用directoryで生成し、command引数やartifactへ保存しません。
credential="$(openssl rand -hex 32)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "${secret_dir}/key.pem" -out "${secret_dir}/cert.pem" >/dev/null 2>&1
chmod 600 "${secret_dir}/key.pem"

# installed ros2 run entrypointを実ROS contextで起動し、HTTPS readyと正常終了を確認します。
export BRIDGE_CREDENTIAL="${credential}"
export BRIDGE_CONFIG="${share_dir}/examples/connection.yaml"
export BRIDGE_TLS_KEY="${secret_dir}/key.pem"
export BRIDGE_TLS_CERT="${secret_dir}/cert.pem"
export BRIDGE_HOST='127.0.0.1'
export BRIDGE_PORT="${smoke_port}"
export BRIDGE_SUBSCRIBE_TOPICS='/output,/observed'
export BRIDGE_PUBLISH_SCOPES='integration'
echo 'packaging smoke: starting installed ros2 run entrypoint'
bash -lc "source '/opt/ros/${ros_distro}/setup.bash' && source '${install_setup}' && exec ros2 run '${package_name}' '${package_name}'" \
  >"${result_dir}/ros2-run.log" 2>&1 &
gateway_pid=$!
node "${repo_root}/tests/packaging/runtime-helper.mjs" health "https://127.0.0.1:${smoke_port}/health" 20000
stop_gateway 'ros2 run'

# launch fileもinstalled pathから実際にprocessを起動し、構文確認だけで済ませません。
echo 'packaging smoke: starting installed launch file'
bash -lc "source '/opt/ros/${ros_distro}/setup.bash' && source '${install_setup}' && exec ros2 launch '${package_name}' bridge.launch.py config:='${share_dir}/examples/connection.yaml' host:=127.0.0.1 port:='${smoke_port}' node_name:=ros_webrtc_packaging_smoke" \
  >"${result_dir}/ros2-launch.log" 2>&1 &
gateway_pid=$!
node "${repo_root}/tests/packaging/runtime-helper.mjs" health "https://127.0.0.1:${smoke_port}/health" 20000
stop_gateway 'ros2 launch'

# 未導入interfaceを持つ設定は起動完了せず、dynamic依存をdeployment側へ要求します。
missing_config="${secret_dir}/missing-interface.yaml"
node "${repo_root}/tests/packaging/runtime-helper.mjs" missing-interface-config \
  "${share_dir}/examples/connection.yaml" "${missing_config}"
export BRIDGE_CONFIG="${missing_config}"
echo 'packaging smoke: verifying missing dynamic interface fails closed'
set +e
timeout --kill-after=5s 20s bash -lc \
  "source '/opt/ros/${ros_distro}/setup.bash' && source '${install_setup}' && exec ros2 run '${package_name}' '${package_name}'" \
  >"${result_dir}/missing-interface.log" 2>&1
missing_status=$?
set -e
if [[ "${missing_status}" -eq 0 || "${missing_status}" -eq 124 || "${missing_status}" -eq 137 ]]; then
  echo "missing interface did not fail fast: exit ${missing_status}" >&2
  exit 1
fi

# 公開可能logに実行時credentialが混入していないことを最後に値一致で確認します。
if grep -R -F -q -m 1 -- "${credential}" "${result_dir}"; then
  echo 'runtime credential leaked into packaging smoke logs' >&2
  exit 1
fi

echo "packaging smoke: ${ros_distro} PASS"
