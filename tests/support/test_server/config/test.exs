import Config

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :test_server, TestServerWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "DDssS1iT6DUJCZDjdF8G96oAe0ltmvXxizf1ll50h6WVtu90IarmexIMkrfDl79x",
  server: false

# In test we don't send emails.
config :test_server, TestServer.Mailer, adapter: Swoosh.Adapters.Test

# Disable swoosh api client as it is only required for production adapters.
config :swoosh, :api_client, false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Never read/write development checklist records from a test run.
config :test_server,
       :checklist_store_path,
       Path.join(
         System.tmp_dir!(),
         "liveview-checklists-test-#{System.unique_integer([:positive])}.dets"
       )

config :test_server, observe_local: true

# Explicitly demo-only credentials; production has no enabled credential set.
config :test_server, :demo_credentials, %{
  "workshop" => "workshop-demo",
  "studio" => "studio-demo"
}

config :test_server,
       :attachment_store_path,
       Path.join(System.tmp_dir!(), "liveview-checklist-uploads-#{System.pid()}")
