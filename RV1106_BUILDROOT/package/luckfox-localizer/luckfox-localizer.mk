################################################################################
# luckfox-localizer
################################################################################

LUCKFOX_LOCALIZER_VERSION = 1.0
LUCKFOX_LOCALIZER_SITE = $(LUCKFOX_LOCALIZER_PKGDIR)/src
LUCKFOX_LOCALIZER_SITE_METHOD = local

define LUCKFOX_LOCALIZER_BUILD_CMDS
	$(TARGET_CXX) $(TARGET_CXXFLAGS) -std=c++17 -Wall -Wextra \
		-I$(@D)/include \
		$(@D)/src/crc32.cpp $(@D)/src/map_io.cpp $(@D)/src/localizer.cpp \
		$(@D)/tools/map_inspect.cpp -o $(@D)/map_inspect
	$(TARGET_CXX) $(TARGET_CXXFLAGS) -std=c++17 -Wall -Wextra \
		-I$(@D)/include \
		$(@D)/src/crc32.cpp $(@D)/src/map_io.cpp $(@D)/src/localizer.cpp \
		$(@D)/tools/localize_scan.cpp -o $(@D)/localize_scan
endef

define LUCKFOX_LOCALIZER_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/map_inspect $(TARGET_DIR)/usr/bin/map_inspect
	$(INSTALL) -D -m 0755 $(@D)/localize_scan $(TARGET_DIR)/usr/bin/localize_scan
	@if [ -f "$(@D)/maps/ruang_utama.bin" ]; then \
		$(INSTALL) -D -m 0644 "$(@D)/maps/ruang_utama.bin" \
			"$(TARGET_DIR)/etc/slam/ruang_utama.bin"; \
	fi
endef

$(eval $(generic-package))
