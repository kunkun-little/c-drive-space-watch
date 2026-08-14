//go:build !windows

package diskusage

func AllocatedSize(_ string, logicalSize int64) int64 { return logicalSize }
