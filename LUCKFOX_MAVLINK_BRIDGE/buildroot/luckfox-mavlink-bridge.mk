LUCKFOX_MAVLINK_BRIDGE_VERSION = 1.0
LUCKFOX_MAVLINK_BRIDGE_SITE = $(LUCKFOX_MAVLINK_BRIDGE_PKGDIR)/src
LUCKFOX_MAVLINK_BRIDGE_SITE_METHOD = local

define LUCKFOX_MAVLINK_BRIDGE_BUILD_CMDS
	$(TARGET_CXX) $(TARGET_CXXFLAGS) -std=c++17 -Wall -Wextra \
		$(@D)/main.cpp -o $(@D)/mavlink_bridge $(TARGET_LDFLAGS)
endef

define LUCKFOX_MAVLINK_BRIDGE_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/mavlink_bridge $(TARGET_DIR)/usr/bin/mavlink_bridge
	$(INSTALL) -D -m 0755 $(LUCKFOX_MAVLINK_BRIDGE_PKGDIR)/S98mavlink_bridge \
		$(TARGET_DIR)/etc/init.d/S98mavlink_bridge
	$(INSTALL) -D -m 0644 $(LUCKFOX_MAVLINK_BRIDGE_PKGDIR)/mavlink_bridge.default \
		$(TARGET_DIR)/etc/default/mavlink_bridge
endef

$(eval $(generic-package))
