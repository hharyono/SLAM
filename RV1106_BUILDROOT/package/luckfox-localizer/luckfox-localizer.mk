################################################################################
# luckfox-localizer
################################################################################

LUCKFOX_LOCALIZER_VERSION = 1.0
LUCKFOX_LOCALIZER_SITE = $(LUCKFOX_LOCALIZER_PKGDIR)/src
LUCKFOX_LOCALIZER_SITE_METHOD = local
LUCKFOX_LOCALIZER_DEPENDENCIES = ydlidar-sdk

define LUCKFOX_LOCALIZER_BUILD_CMDS
	$(TARGET_CXX) $(TARGET_CXXFLAGS) -std=c++17 -Wall -Wextra \
		-I$(@D)/include \
		$(@D)/src/crc32.cpp $(@D)/src/map_io.cpp $(@D)/src/localizer.cpp \
		$(@D)/tools/map_inspect.cpp -o $(@D)/map_inspect
	$(TARGET_CXX) $(TARGET_CXXFLAGS) -std=c++17 -Wall -Wextra \
		-I$(@D)/include \
		$(@D)/src/crc32.cpp $(@D)/src/map_io.cpp $(@D)/src/localizer.cpp \
		$(@D)/tools/localize_scan.cpp -o $(@D)/localize_scan
	$(TARGET_CXX) $(TARGET_CXXFLAGS) -std=c++17 -Wall -Wextra \
		-I$(@D)/include -I$(STAGING_DIR)/usr/include/src \
		-I$(STAGING_DIR)/usr/include \
		$(@D)/src/crc32.cpp $(@D)/src/map_io.cpp $(@D)/src/localizer.cpp \
		$(@D)/src/uart_localizer.cpp $(@D)/src/robot_backend_client.cpp \
		$(@D)/src/scan_tcp_client.cpp \
		$(@D)/tools/localize_uart.cpp \
		$(STAGING_DIR)/usr/lib/libydlidar_sdk.a -lpthread \
		-o $(@D)/localize_uart
endef

define LUCKFOX_LOCALIZER_INSTALL_TARGET_CMDS
	rm -f $(TARGET_DIR)/etc/init.d/S95localize_uart
	$(INSTALL) -D -m 0755 $(@D)/map_inspect $(TARGET_DIR)/usr/bin/map_inspect
	$(INSTALL) -D -m 0755 $(@D)/localize_scan $(TARGET_DIR)/usr/bin/localize_scan
	$(INSTALL) -D -m 0755 $(@D)/localize_uart $(TARGET_DIR)/usr/bin/localize_uart
	$(INSTALL) -D -m 0755 $(LUCKFOX_LOCALIZER_PKGDIR)/S99zzlocalize_uart \
		$(TARGET_DIR)/etc/init.d/S99zzlocalize_uart
	$(INSTALL) -D -m 0644 $(LUCKFOX_LOCALIZER_PKGDIR)/localize_uart.default \
		$(TARGET_DIR)/etc/default/localize_uart
	@if [ -f "$(@D)/maps/ruang_utama.bin" ]; then \
		$(INSTALL) -D -m 0644 "$(@D)/maps/ruang_utama.bin" \
			"$(TARGET_DIR)/etc/slam/ruang_utama.bin"; \
	fi
endef

$(eval $(generic-package))
