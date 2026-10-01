defmodule TestServerWeb.Layouts.ReactNative do
  use TestServerNative, [:layout, format: :react_native]

  embed_templates "layouts_react_native/*"
end
