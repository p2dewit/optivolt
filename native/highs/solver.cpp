#include <Highs.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unistd.h>
#include <vector>

using nlohmann::json;

namespace {

bool applyOption(Highs& highs, const std::string& name, const json& value) {
  HighsStatus status = HighsStatus::kError;
  if (value.is_boolean()) {
    status = highs.setOptionValue(name, value.get<bool>());
  } else if (value.is_number_integer()) {
    status = highs.setOptionValue(name, value.get<HighsInt>());
  } else if (value.is_number()) {
    status = highs.setOptionValue(name, value.get<double>());
  } else if (value.is_string()) {
    status = highs.setOptionValue(name, value.get<std::string>());
  } else {
    std::cerr << "Unsupported option value type for " << name << '\n';
    return false;
  }
  if (status == HighsStatus::kError) {
    std::cerr << "HiGHS rejected option " << name << '\n';
    return false;
  }
  return true;
}

std::string createTemporaryModel(const std::string& lpText) {
  char path[] = "/tmp/optivolt-highs-XXXXXX.lp";
  // mkstemps keeps the .lp suffix so HiGHS recognizes the input format.
  const int fd = mkstemps(path, 3);
  if (fd < 0) throw std::runtime_error("Could not create temporary LP file");
  const ssize_t written = write(fd, lpText.data(), lpText.size());
  close(fd);
  if (written != static_cast<ssize_t>(lpText.size())) {
    std::remove(path);
    throw std::runtime_error("Could not write complete LP model");
  }
  return path;
}

json solve(const json& request) {
  if (!request.contains("lpText") || !request["lpText"].is_string()) {
    throw std::runtime_error("Request is missing string lpText");
  }
  const std::string modelPath = createTemporaryModel(request["lpText"].get<std::string>());
  Highs highs;
  highs.setOptionValue("output_flag", false);
  // HiGHS 1.15 supports parallel MIP tree search. The UI controls whether it
  // is enabled and the requested maximum thread count.
  const json solverSettings = request.value("solverSettings", json::object());
  const bool multiThreadingEnabled = solverSettings.value("multiThreadingEnabled", true);
  const HighsInt maxThreads = solverSettings.value("maxThreads", 4);
  if (!applyOption(highs, "threads", multiThreadingEnabled ? maxThreads : 1) ||
      !applyOption(highs, "parallel", multiThreadingEnabled ? "on" : "off")) {
    std::remove(modelPath.c_str());
    throw std::runtime_error("Could not enable parallel HiGHS MIP solving");
  }
  if (request.contains("options") && request["options"].is_object()) {
    for (auto it = request["options"].begin(); it != request["options"].end(); ++it) {
      if (it.key() == "threads" || it.key() == "parallel" ||
          !applyOption(highs, it.key(), it.value())) {
        std::remove(modelPath.c_str());
        throw std::runtime_error("Invalid solver option: " + it.key());
      }
    }
  }
  const HighsStatus readStatus = highs.readModel(modelPath);
  std::remove(modelPath.c_str());
  if (readStatus == HighsStatus::kError) throw std::runtime_error("HiGHS could not read LP model");

  if (request.contains("warmColumns") && request["warmColumns"].is_object()) {
    const auto& names = highs.getLp().col_names_;
    std::map<std::string, HighsInt> nameToIndex;
    for (HighsInt i = 0; i < static_cast<HighsInt>(names.size()); ++i) nameToIndex[names[i]] = i;
    std::vector<HighsInt> indices;
    std::vector<double> values;
    for (auto it = request["warmColumns"].begin(); it != request["warmColumns"].end(); ++it) {
      const auto found = nameToIndex.find(it.key());
      if (found != nameToIndex.end() && it.value().is_number()) {
        indices.push_back(found->second);
        values.push_back(it.value().get<double>());
      }
    }
    if (!indices.empty()) highs.setSolution(static_cast<HighsInt>(indices.size()), indices.data(), values.data());
  }

  if (highs.run() == HighsStatus::kError) throw std::runtime_error("HiGHS run failed");
  const HighsModelStatus modelStatus = highs.getModelStatus();
  const HighsSolution& solution = highs.getSolution();
  const HighsInfo& info = highs.getInfo();
  json result = {{"Status", highs.modelStatusToString(modelStatus)}};
  if (std::isfinite(info.objective_function_value)) result["ObjectiveValue"] = info.objective_function_value;
  json diagnostics = {
      {"highsVersion", highsVersion()},
      {"numRows", highs.getNumRow()},
      {"numColumns", highs.getNumCol()},
      {"numNonzeros", highs.getNumNz()},
      {"mipNodeCount", info.mip_node_count},
      {"threadsConfigured", multiThreadingEnabled ? maxThreads : 1},
      {"parallel", multiThreadingEnabled},
  };
  if (std::isfinite(info.mip_gap)) diagnostics["mipGap"] = info.mip_gap;
  if (std::isfinite(info.mip_dual_bound)) diagnostics["mipDualBound"] = info.mip_dual_bound;
  result["Diagnostics"] = std::move(diagnostics);
  if (solution.value_valid) {
    const auto& names = highs.getLp().col_names_;
    json columns = json::object();
    for (std::size_t i = 0; i < solution.col_value.size() && i < names.size(); ++i) {
      if (std::isfinite(solution.col_value[i])) columns[names[i]] = {{"Primal", solution.col_value[i]}};
    }
    result["Columns"] = std::move(columns);
  }
  return result;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--capabilities") {
    std::cout << json({{"highsVersion", highsVersion()}, {"configurableThreads", true}}).dump() << '\n';
    return 0;
  }
  if (argc == 2 && std::string(argv[1]) == "--version") {
    std::cout << "HiGHS " << highsVersion() << " (native MIP bridge)\n";
    return 0;
  }
  try {
    json request;
    std::cin >> request;
    std::cout << solve(request).dump() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
