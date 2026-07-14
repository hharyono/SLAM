################################################################################
# ydlidar-sdk
################################################################################

YDLIDAR_SDK_VERSION = 1.2.7
YDLIDAR_SDK_SITE = $(YDLIDAR_SDK_PKGDIR)/src
YDLIDAR_SDK_SITE_METHOD = local
YDLIDAR_SDK_INSTALL_STAGING = YES
YDLIDAR_SDK_INSTALL_TARGET = NO
YDLIDAR_SDK_CONF_OPTS = \
	-DBUILD_SHARED_LIBS=OFF \
	-DBUILD_EXAMPLES=OFF \
	-DBUILD_TEST=OFF \
	-DBUILD_CSHARP=OFF \
	-DCMAKE_DISABLE_FIND_PACKAGE_SWIG=TRUE \
	-DCMAKE_DISABLE_FIND_PACKAGE_PythonInterp=TRUE \
	-DCMAKE_DISABLE_FIND_PACKAGE_PythonLibs=TRUE \
	-DCMAKE_DISABLE_FIND_PACKAGE_GTest=TRUE

$(eval $(cmake-package))
