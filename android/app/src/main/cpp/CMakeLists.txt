# Builds the JNI bridge against the prebuilt libnode. The paths are relative
# to this file (app/src/main/cpp/).
cmake_minimum_required(VERSION 3.4.1)

add_library(nodejs-mobile-react-native-native-lib SHARED
            native-lib.cpp
            rn-bridge.cpp)

include_directories(include/node/)
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
            ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(nodejs-mobile-react-native-native-lib
            libnode
            ${log-lib})
