#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Penggunaan: $0 NAMA_MAP"
    echo "Contoh: $0 ruang_utama"
    exit 2
fi

ScriptDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ProjectDir="$(dirname "$ScriptDir")"
RepoDir="$(dirname "$ProjectDir")"
MapDir="$RepoDir/maps"
Name="$1"

mkdir -p "$MapDir"
source /opt/ros/humble/setup.bash

ros2 run nav2_map_server map_saver_cli \
    -f "$MapDir/$Name" \
    --ros-args -p map_subscribe_transient_local:=true

cmake -S "$ProjectDir" -B "$ProjectDir/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$ProjectDir/build" --target map_converter -j"$(nproc)"
"$ProjectDir/build/map_converter" "$MapDir/$Name.yaml" "$MapDir/$Name.bin"
"$ProjectDir/build/map_inspect" "$MapDir/$Name.bin"

echo "Map untuk RV1106: $MapDir/$Name.bin"
