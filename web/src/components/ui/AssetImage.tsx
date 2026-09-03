"use client";
/* eslint-disable @next/next/no-img-element */

import type { ImgHTMLAttributes, ReactEventHandler } from "react";
import { useState } from "react";

type AssetImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string;
  fallback: string;
  fallbackClassName?: string;
};

export function AssetImage({
  alt,
  className,
  fallback,
  fallbackClassName,
  onError,
  src,
  ...props
}: AssetImageProps) {
  const [failed, setFailed] = useState(false);

  const handleError: ReactEventHandler<HTMLImageElement> = (event) => {
    setFailed(true);
    onError?.(event);
  };

  if (!src || failed) {
    return (
      <span
        role="img"
        aria-label={alt}
        className={fallbackClassName ?? className ?? "assetFallback"}
      >
        {fallback}
      </span>
    );
  }

  return <img {...props} src={src} alt={alt} className={className} onError={handleError} />;
}
