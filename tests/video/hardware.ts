/**
 * Running a GStreamer backend against the host's own L4T plugins.
 *
 * This project never bundles GStreamer, so a hardware run borrows the plugins already installed on
 * the machine. That only works when the container's Ubuntu release matches the host's: the encoder
 * plugin calls glib 2.80 symbols, and that glib needs a newer glibc than an older base provides. The
 * mismatch fails in the loader, so there is nothing to detect at run time - the caller picks a base
 * that matches, or the element is simply absent.
 */

/** Where the host keeps its multiarch libraries. Overridable for a non-aarch64 host. */
const LIBDIR = process.env.VIDEO_HOST_LIBDIR ?? '/usr/lib/aarch64-linux-gnu';

// Exactly the elements the L4T chain needs. Exposing the host's whole plugin directory instead would
// make GStreamer scan every plugin on the machine - hundreds of them, most failing against a
// different base - which is slow enough to delay startup and hides a real failure in the noise.
const PLUGINS = ['libgstnvvideo4linux2.so', 'libgstnvvidconv.so'];

/**
 * Docker arguments that expose the host encoder to the gateway container.
 *
 * Only `libcuda.so.1` is bind-mounted by name: the NVIDIA container runtime injects the rest of the
 * driver, and `libEGL`/`libGLESv2` already come with `gstreamer1.0-plugins-bad`. Nothing is added to
 * the image.
 *
 * @returns Arguments to append to `docker run`, e.g. `['-v', '/usr/lib/...:/hostgst:ro', ...]`.
 */
export function hardwareArgs(): string[] {
  return [
    // Naming the runtime rather than relying on the daemon default: whether `nvidia` is the default
    // varies between otherwise identical Jetsons, and without it the driver is never injected.
    '--runtime', process.env.VIDEO_DOCKER_RUNTIME ?? 'nvidia',
    ...PLUGINS.flatMap(plugin => ['-v', `${LIBDIR}/gstreamer-1.0/${plugin}:/hostgst/${plugin}:ro`]),
    '-v', `${LIBDIR}/libcuda.so.1:/opt/nvcuda/libcuda.so.1:ro`,
    '--env', 'GST_PLUGIN_PATH=/hostgst',
    '--env', `LD_LIBRARY_PATH=${LIBDIR}/nvidia:${LIBDIR}/tegra:/opt/nvcuda`,
    // The runtime injects the driver libraries and the encoder device node only when asked.
    '--env', 'NVIDIA_VISIBLE_DEVICES=all', '--env', 'NVIDIA_DRIVER_CAPABILITIES=all',
  ];
}

/**
 * Record what the host actually is, so an evidence file is attributable to a machine.
 * @param run Command runner, so this module spawns nothing itself.
 * @returns Host facts, e.g. `{arch: 'aarch64', l4t: 'R39 (release), REVISION: 2.0', ...}`.
 */
export async function hardwareEvidence(run: (name: string, executable: string, args: string[]) => Promise<string>) {
  /** Read one fact, treating absence as a recorded value rather than a failure. */
  const fact = async (name: string, executable: string, args: string[]): Promise<string> =>
    run(name, executable, args).then(value => value.trim().split('\n')[0] ?? '').catch(() => 'unavailable');
  return {
    arch: await fact('host-arch', 'uname', ['-m']),
    kernel: await fact('host-kernel', 'uname', ['-r']),
    l4t: await fact('host-l4t', 'head', ['-1', '/etc/nv_tegra_release']),
    gstreamer: await fact('host-gst', 'gst-inspect-1.0', ['--version']),
    encoderPresent: await fact('host-encoder', 'sh', ['-c', 'gst-inspect-1.0 nvv4l2h264enc >/dev/null 2>&1 && echo yes || echo no']),
  };
}
