import React from 'react'
import { Link } from 'wouter'

const Home = (props: { time: number }) => {
  return (
    <>
      <h1>Hello</h1>
      <p>Hi.</p>
      <p suppressHydrationWarning={true}>This page was rendered at {props.time}</p>
      <Link id="about-link" href="about">
        About
      </Link>
      <br />
      <Link id="red-about-link" href="~/red/about">
        Red About
      </Link>
      <br />
      <Link href="navigation-test"> Navigation Test </Link>
    </>
  )
}

export default Home
