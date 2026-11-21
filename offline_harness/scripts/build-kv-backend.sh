#!/bin/sh
# Build the pinned llama.cpp release with KV telemetry and protected /btw slots.
set -eu
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "Usage: $0 LLAMA_SOURCE_DIR BUILD_DIR [CUDA_TOOLKIT_DIR]" >&2
    exit 2
fi
source_dir=$(realpath "$1")
build_dir=$(realpath -m "$2")
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
revision=69ee2ecc0150ba7d1204a7f7393dfd651569db8c
patch_file="$script_dir/../patches/llama-b12144-kv-cells.patch"
btw_patch="$script_dir/../patches/llama-b12144-btw.patch"
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]; then
    echo "Source must be checked out at llama.cpp b12144 ($revision)" >&2
    exit 1
fi
# Upgrade source trees patched by older releases as well as fresh checkouts.
# KV telemetry synchronizes CUDA; it must wait until decode/graph capture ends.
python3 - "$source_dir/tools/server/server-context.cpp" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
guard = 'if (is_yielding && task.type != SERVER_TASK_TYPE_METRICS && task.type != SERVER_TASK_TYPE_SLOT_GET'
text = text.replace(guard + ' && task.type != SERVER_TASK_TYPE_KV_STATS)', guard + ')')
text = text.replace('// Cell metadata is owned by this thread. Synchronize queued\n                    // device work before observing the associated tensors.',
                    '// Deferred while is_yielding: synchronizing during concurrent\n                    // decode can race CUDA graph capture and abort the server.')
if guard + ')' not in text:
    raise SystemExit('Unrecognized decode task gate; cannot safely build KV telemetry')
if text != p.read_text():
    p.write_text(text)
PY
if git -C "$source_dir" apply --reverse --check "$btw_patch" 2>/dev/null; then
    # The second patch changes nearby telemetry hunks in server-context.cpp.
    # Check the remaining telemetry files plus the endpoint marker without
    # temporarily undoing either patch in the caller's source tree.
    git -C "$source_dir" apply --reverse --check --exclude=tools/server/server-context.cpp "$patch_file"
    if ! grep -q 'case SERVER_TASK_TYPE_KV_STATS:' "$source_dir/tools/server/server-context.cpp"; then
        echo "The /btw patch is present but KV telemetry is incomplete" >&2
        exit 1
    fi
else
    if git -C "$source_dir" apply --check "$patch_file" 2>/dev/null; then
        git -C "$source_dir" apply "$patch_file"
    else
        git -C "$source_dir" apply --reverse --check "$patch_file"
    fi
    git -C "$source_dir" apply --check "$btw_patch"
    git -C "$source_dir" apply "$btw_patch"
fi
if [ "$#" -eq 3 ]; then
    toolkit_dir=$(realpath "$3")
    set -- "-DCUDAToolkit_ROOT=$toolkit_dir" "-DCMAKE_CUDA_COMPILER=$toolkit_dir/bin/nvcc"
    LD_LIBRARY_PATH="$toolkit_dir/lib:$toolkit_dir/lib64:${LD_LIBRARY_PATH:-}"
    export LD_LIBRARY_PATH
else
    set --
fi
cmake -S "$source_dir" -B "$build_dir" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON \
    -DLLAMA_BUILD_NUMBER=12144 -DLLAMA_BUILD_COMMIT=69ee2ecc-btw \
    "-DCMAKE_CUDA_ARCHITECTURES=${MINI_CTF_CUDA_ARCH:-native}" \
    -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF "$@"
cmake --build "$build_dir" --target llama-server --parallel "${MINI_CTF_BUILD_JOBS:-4}"
