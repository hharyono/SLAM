file(MAKE_DIRECTORY "${TEST_DIR}")
file(COPY "${SOURCE_DIR}/align.yaml" "${SOURCE_DIR}/align.pgm" DESTINATION "${TEST_DIR}")

execute_process(
  COMMAND "${MAP_ALIGN}" "${TEST_DIR}/align.yaml"
  RESULT_VARIABLE result
  OUTPUT_VARIABLE output
  ERROR_VARIABLE error)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "map_align failed: ${output}${error}")
endif()

file(READ "${TEST_DIR}/align.yaml" yaml)
if(NOT yaml MATCHES "origin: \\[[-0-9.]+, [-0-9.]+, [-0-9.]+\\]")
  message(FATAL_ERROR "aligned YAML has no numeric origin: ${yaml}")
endif()
if(NOT EXISTS "${TEST_DIR}/align.alignment.json")
  message(FATAL_ERROR "map_align did not write an alignment report")
endif()
