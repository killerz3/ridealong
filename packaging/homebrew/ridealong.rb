# Homebrew formula for the killerz3/homebrew-tap repo.
# On each release: update url to the new tag and sha256 to `shasum -a 256 ridealong.tgz`.
class Ridealong < Formula
  desc "One logged-in browser for you and your AI agents"
  homepage "https://ridealong.kz3.dev/"
  url "https://github.com/killerz3/ridealong/releases/download/v0.4.0/ridealong.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  service do
    run [opt_bin/"ridealong", "start"]
    keep_alive successful_exit: false
    environment_variables PATH: std_service_path_env
    log_path var/"log/ridealong.log"
    error_log_path var/"log/ridealong.log"
  end

  def caveats
    <<~EOS
      Set the viewer password and find Chrome once:
        ridealong setup
      Then run it in the background and at login:
        brew services start ridealong
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ridealong --version")
  end
end
