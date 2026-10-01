require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'LiveViewNative'
  s.version = package['version']
  s.summary = 'React Native renderer bridge for the Rust LiveView Native core'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'LiveView Native contributors'
  s.homepage = 'https://github.com/jtomchak/liveview-native-core'
  s.source = { :git => 'https://github.com/jtomchak/liveview-native-core.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift', 'generated/*.swift'
  s.vendored_frameworks = 'frameworks/liveview_native_core.xcframework'
  s.libraries = 'c++', 'resolv'
  s.frameworks = 'Security', 'SystemConfiguration'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
