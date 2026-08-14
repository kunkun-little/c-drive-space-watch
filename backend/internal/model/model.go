package model

import "time"

type Snapshot struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	RootPath       string     `json:"rootPath"`
	Status         string     `json:"status"`
	RecordFileData bool       `json:"recordFileData"`
	CreatedAt      time.Time  `json:"createdAt"`
	FinishedAt     *time.Time `json:"finishedAt,omitempty"`
	EntryCount     int64      `json:"entryCount"`
	FileCount      int64      `json:"fileCount"`
	DirCount       int64      `json:"dirCount"`
	TotalSize      int64      `json:"totalSize"`
	SkippedCount   int64      `json:"skippedCount"`
	ErrorMessage   string     `json:"errorMessage,omitempty"`
}

type Entry struct {
	RelPath     string `json:"relPath"`
	ParentRel   string `json:"parentRel"`
	Name        string `json:"name"`
	IsDir       bool   `json:"isDir"`
	Size        int64  `json:"size"`
	ModTimeNS   int64  `json:"modTimeNs"`
	FileCount   int64  `json:"fileCount"`
	Fingerprint int64  `json:"-"`
}

type CompareEntry struct {
	RelPath    string `json:"relPath"`
	Name       string `json:"name"`
	IsDir      bool   `json:"isDir"`
	Status     string `json:"status"`
	SizeA      int64  `json:"sizeA"`
	SizeB      int64  `json:"sizeB"`
	Delta      int64  `json:"delta"`
	FileCountA int64  `json:"fileCountA"`
	FileCountB int64  `json:"fileCountB"`
	ModTimeNSA int64  `json:"modTimeNsA"`
	ModTimeNSB int64  `json:"modTimeNsB"`
}
