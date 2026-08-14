//go:build windows

package diskusage

import (
	"syscall"
	"unsafe"
)

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procGetCompressedFileSize = kernel32.NewProc("GetCompressedFileSizeW")
)

// AllocatedSize returns the number of bytes Windows reports as occupied on disk.
// It falls back to logicalSize when the Win32 query cannot be completed.
func AllocatedSize(path string, logicalSize int64) int64 {
	ptr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return logicalSize
	}
	var high uint32
	low, _, callErr := procGetCompressedFileSize.Call(
		uintptr(unsafe.Pointer(ptr)),
		uintptr(unsafe.Pointer(&high)),
	)
	if uint32(low) == 0xFFFFFFFF && callErr != syscall.Errno(0) {
		return logicalSize
	}
	return int64(uint64(high)<<32 | uint64(uint32(low)))
}
