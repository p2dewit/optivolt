cmake_minimum_required(VERSION 3.20)
project(optivolt_highs_bridge LANGUAGES CXX)

if(NOT DEFINED HIGHS_SOURCE_DIR)
  message(FATAL_ERROR "Set HIGHS_SOURCE_DIR to a HiGHS source checkout")
endif()

set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(FAST_BUILD ON CACHE BOOL "" FORCE)
set(BUILD_CXX ON CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
add_subdirectory("${HIGHS_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/highs")

find_package(nlohmann_json CONFIG REQUIRED)
add_executable(highs-native-bridge solver.cpp)
target_compile_features(highs-native-bridge PRIVATE cxx_std_17)
target_link_libraries(highs-native-bridge PRIVATE highs nlohmann_json::nlohmann_json)
