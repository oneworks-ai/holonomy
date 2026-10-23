cmake_minimum_required(VERSION 3.22.1)

project(holonomy_engine_gate LANGUAGES CXX)

add_library(holonomy_engine_gate SHARED android_engine_gate.cpp)
target_compile_features(holonomy_engine_gate PRIVATE cxx_std_20)
target_compile_options(holonomy_engine_gate PRIVATE -fexceptions -frtti -Wall -Wextra -Werror)
target_link_libraries(holonomy_engine_gate PRIVATE android dl log)
