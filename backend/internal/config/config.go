package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	Listen           string   `json:"listen"`
	DefaultScanRoot  string   `json:"defaultScanRoot"`
	ExcludePaths     []string `json:"excludePaths"`
	UseAllocatedSize bool     `json:"useAllocatedSize"`
	RecordFileData   bool     `json:"recordFileData"`
}

type Store struct {
	mu   sync.RWMutex
	path string
	cfg  Config
}

func Default() Config {
	return Config{
		Listen:           "127.0.0.1:8899",
		DefaultScanRoot:  `C:\Users`,
		ExcludePaths:     []string{},
		UseAllocatedSize: true,
		RecordFileData:   false,
	}
}

func New(path string) (*Store, error) {
	s := &Store{path: path, cfg: Default()}
	if err := s.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := s.Save(s.cfg); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) Load() error {
	b, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	cfg := Default()
	if err := json.Unmarshal(b, &cfg); err != nil {
		return err
	}
	s.mu.Lock()
	s.cfg = cfg
	s.mu.Unlock()
	return nil
}

func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cfg := s.cfg
	// Keep empty collections as [] in the JSON API instead of null.
	cfg.ExcludePaths = append([]string{}, s.cfg.ExcludePaths...)
	return cfg
}

func (s *Store) Save(cfg Config) error {
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8899"
	}
	if cfg.DefaultScanRoot == "" {
		cfg.DefaultScanRoot = `C:\Users`
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.path, b, 0o644); err != nil {
		return err
	}
	s.mu.Lock()
	s.cfg = cfg
	s.mu.Unlock()
	return nil
}
