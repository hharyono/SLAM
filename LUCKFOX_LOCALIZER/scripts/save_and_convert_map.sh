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
# ROS environment hooks may probe optional variables that are not defined.
# Temporarily disable nounset while sourcing the generated setup script.
set +u
source /opt/ros/humble/setup.bash
set -u

ros2 run nav2_map_server map_saver_cli \
    -f "$MapDir/$Name" \
    --ros-args -p map_subscribe_transient_local:=true

cmake -S "$ProjectDir" -B "$ProjectDir/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$ProjectDir/build" --target map_align map_converter map_inspect -j"$(nproc)"
"$ProjectDir/build/map_align" "$MapDir/$Name.yaml"
"$ProjectDir/build/map_converter" "$MapDir/$Name.yaml" "$MapDir/$Name.bin"
"$ProjectDir/build/map_inspect" "$MapDir/$Name.bin"

echo "Auto alignment: $MapDir/$Name.alignment.json"
echo "Normalized origin: (0, 0, 0); unknown border cropped"
echo "Map untuk RV1106: $MapDir/$Name.bin"
