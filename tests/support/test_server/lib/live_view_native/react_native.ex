defmodule LiveViewNative.ReactNative.Component do
  @moduledoc false
  defmacro __using__(_) do
    quote do
    end
  end
end

defmodule LiveViewNative.ReactNative do
  @moduledoc """
  React Native format registration for the Rust core / Expo proof of concept.

  The client bundle owns the component registry and the named style tokens.
  This plugin emits only data and the installed View, Text and Pressable tags.
  """
  use LiveViewNative,
    format: :react_native,
    component: LiveViewNative.ReactNative.Component,
    module_suffix: :ReactNative,
    template_engine: LiveViewNative.Template.Engine
end
