package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"c-drive-space-watch/internal/api"
	"c-drive-space-watch/internal/config"
	"c-drive-space-watch/internal/db"
	"c-drive-space-watch/internal/scanner"
)

func main() {
	base := resolveBaseDir()
	cfgStore, err := config.New(filepath.Join(base, "config", "config.json"))
	if err != nil {
		log.Fatal(err)
	}
	dataDir := filepath.Join(base, "data")
	store, err := db.Open(filepath.Join(dataDir, "spacewatch.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	webDir := ""
	for _, candidate := range []string{filepath.Join(base, "web"), filepath.Join(base, "frontend", "dist")} {
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			webDir = candidate
			break
		}
	}
	server := api.New(store, cfgStore, scanner.NewManager(store, dataDir), webDir)
	addr := cfgStore.Get().Listen
	fmt.Printf("C Drive Space Watch\n")
	fmt.Printf("数据目录: %s\n", filepath.Join(base, "data"))
	fmt.Printf("服务地址: http://%s\n", addr)
	if webDir == "" {
		fmt.Println("提示: 未检测到前端 dist，请运行前端开发服务器或先执行 build.bat")
	}
	log.Fatal(http.ListenAndServe(addr, server.Handler()))
}

func resolveBaseDir() string {
	if v := os.Getenv("SPACEWATCH_HOME"); v != "" {
		if abs, err := filepath.Abs(v); err == nil {
			return abs
		}
	}
	cwd, err := os.Getwd()
	if err == nil {
		return cwd
	}
	exe, _ := os.Executable()
	return filepath.Dir(exe)
}
